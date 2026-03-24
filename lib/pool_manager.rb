# frozen_string_literal: false

require 'securerandom'
require 'open3'
require 'json'
require 'fileutils'
require 'time'
require 'bundler'

class PoolManager
  CONFIG_FILE = File.join(__dir__, '..', 'config.json')
  PERSIST_FILE = File.join(__dir__, '..', 'data', 'state.json')
  SAVE_INTERVAL = 2 # seconds between auto-saves (debounced)

  attr_reader :version

  def initialize
    @tasks = {}          # id => task hash
    @task_order = []     # ordered ids (all tasks)
    @max_parallel = nil
    @agent_cmd = nil
    @agent_args = nil
    @work_dir = nil
    @session_viewer_url = nil
    @allowed_hosts = nil
    @review_sections = {} # id => {id:, name:, prompt:}
    @templates = {}      # id => {id:, name:, template:}
    @paused = false
    @mutex = Mutex.new
    @running = false
    @version = 0
    @chat_threads = {}
    @last_saved_version = 0
    @last_save_time = Time.now

    load_config
    load_state
  end

  def start
    @running = true
    @monitor_thread = Thread.new { monitor_loop }
  end

  def stop
    @running = false
    @monitor_thread&.join(5)
    save_state
  end

  # --- State ---

  def state
    @mutex.synchronize { state_unlocked }
  end

  def task_detail(id)
    @mutex.synchronize do
      t = @tasks[id]
      return nil unless t
      serialize_task(t, full: true)
    end
  end

  # --- Task management ---

  def add_task(prompt:, label: nil)
    @mutex.synchronize do
      id = SecureRandom.uuid
      task = build_task(
        id: id,
        prompt: prompt,
        label: label || prompt[0..60],
        created_at: Time.now,
        review_prompts: []
      )
      @tasks[id] = task
      @task_order << id
      bump_version
      id
    end
  end

  def add_tasks_batch(inputs:, template_id:, review: true)
    @mutex.synchronize do
      tmpl = @templates[template_id]
      raise "Template not found" unless tmpl

      ids = []
      inputs.each do |input|
        prompt = format(tmpl[:template], input: input)
        review_prompts = (tmpl[:review_section_ids] || []).filter_map do |section_id|
          @review_sections[section_id]&.dig(:prompt)
        end
        id = SecureRandom.uuid
        task = build_task(
          id: id,
          prompt: prompt,
          label: input,
          created_at: Time.now,
          review_prompts: review_prompts,
          color: tmpl[:color],
          template_id: template_id
        )
        @tasks[id] = task
        @task_order << id
        ids << id
      end
      bump_version
      ids
    end
  end

  def remove_task(id)
    @mutex.synchronize do
      task = @tasks[id]
      return false unless task
      if [:queued, :completed, :failed, :cancelled].include?(task[:status])
        @tasks.delete(id)
        @task_order.delete(id)
        bump_version
        true
      elsif task[:status] == :running
        Process.kill('TERM', task[:pid]) rescue nil
        false
      else
        false
      end
    end
  end

  def cancel_task(id)
    @mutex.synchronize do
      task = @tasks[id]
      return false unless task

      case task[:status]
      when :queued
        task[:status] = :cancelled
        task[:completed_at] = Time.now
        bump_version
        true
      when :running, :reviewing
        begin
          Process.kill('TERM', task[:pid])
        rescue Errno::ESRCH
          # already dead
        rescue TypeError
          # review-only tasks do not have a live child pid
        end
        task[:status] = :cancelled
        task[:completed_at] = Time.now
        task[:cancel_requested] = true
        task[:reader]&.close rescue nil
        task[:reader] = nil
        bump_version
        true
      else
        false
      end
    end
  end

  def cancel_all_tasks
    @mutex.synchronize do
      changed = 0

      @task_order.each do |id|
        task = @tasks[id]
        next unless task

        case task[:status]
        when :queued
          task[:status] = :cancelled
          task[:completed_at] = Time.now
          changed += 1
        when :running, :reviewing
          begin
            Process.kill('TERM', task[:pid])
          rescue Errno::ESRCH
            # already dead
          rescue TypeError
            # review-only tasks do not have a live child pid
          end
          task[:status] = :cancelled
          task[:completed_at] = Time.now
          task[:cancel_requested] = true
          task[:reader]&.close rescue nil
          task[:reader] = nil
          changed += 1
        end
      end

      bump_version if changed > 0
      changed
    end
  end

  def retry_task(id)
    @mutex.synchronize do
      task = @tasks[id]
      return false unless task
      return false unless [:completed, :failed, :cancelled].include?(task[:status])

      task[:status] = :queued
      task[:output] = ""
      task[:session_id] = SecureRandom.uuid
      task[:pid] = nil
      task[:exit_status] = nil
      task[:started_at] = nil
      task[:completed_at] = nil
      task[:reader] = nil
      task[:review_output] = nil
      task[:review_entries] = []
      task[:chat_history] = []
      task[:cancel_requested] = false
      task[:failure_details] = nil
      bump_version
      true
    end
  end

  def reorder_queue(ordered_ids)
    @mutex.synchronize do
      queued = @task_order.select { |id| @tasks[id][:status] == :queued }
      return false unless ordered_ids.sort == queued.sort

      non_queued = @task_order.reject { |id| @tasks[id][:status] == :queued }
      # Maintain order: running tasks first, then reordered queue, then completed
      running = non_queued.select { |id| [:running, :reviewing].include?(@tasks[id][:status]) }
      done = non_queued.reject { |id| [:running, :reviewing].include?(@tasks[id][:status]) }
      @task_order = running + ordered_ids + done
      bump_version
      true
    end
  end

  def clear_completed
    @mutex.synchronize do
      completed_ids = @task_order.select { |id| [:completed, :failed, :cancelled].include?(@tasks[id][:status]) }
      completed_ids.each do |id|
        @tasks.delete(id)
        @task_order.delete(id)
      end
      bump_version
      completed_ids.size
    end
  end

  # --- Controls ---

  def pause
    @mutex.synchronize do
      @paused = true
      bump_version
    end
  end

  def resume
    @mutex.synchronize do
      @paused = false
      bump_version
    end
  end

  def paused?
    @mutex.synchronize { @paused }
  end

  def set_max_parallel(n)
    @mutex.synchronize do
      @max_parallel = [n.to_i, 1].max
      bump_version
    end
  end

  # --- Config ---

  def config
    @mutex.synchronize do
      {
        max_parallel: @max_parallel,
        agent_cmd: @agent_cmd,
        agent_args: @agent_args,
        work_dir: @work_dir,
        session_viewer_url: @session_viewer_url,
        allowed_hosts: @allowed_hosts,
        review_sections: @review_sections.values,
        templates: @templates.values,
        paused: @paused
      }
    end
  end

  def update_config(params)
    @mutex.synchronize do
      config_changed = false
      if params[:max_parallel]
        @max_parallel = [params[:max_parallel].to_i, 1].max
        config_changed = true
      end
      if params[:agent_cmd]
        @agent_cmd = params[:agent_cmd]
        config_changed = true
      end
      if params[:agent_args]
        @agent_args = params[:agent_args]
        config_changed = true
      end
      if params.key?(:work_dir)
        raise "Working directory cannot be empty" if params[:work_dir].to_s.strip.empty?
        @work_dir = params[:work_dir]
        config_changed = true
      end
      if params[:session_viewer_url]
        @session_viewer_url = params[:session_viewer_url]
        config_changed = true
      end
      if params[:allowed_hosts]
        @allowed_hosts = params[:allowed_hosts]
        config_changed = true
      end
      save_config if config_changed
      if params[:review_sections]
        @review_sections = {}
        params[:review_sections].each do |section|
          next unless section[:id] && section[:prompt]
          id = section[:id].to_s
          @review_sections[id] = {
            id: id,
            name: section[:name].to_s,
            prompt: section[:prompt]
          }
        end

        @templates.each_value do |template|
          template[:review_section_ids] = (template[:review_section_ids] || []).select { |id| @review_sections.key?(id) }
        end
      end
      bump_version
    end
  end

  def save_template(id: nil, name:, template:, review_section_ids: [], color: nil, work_dir: nil)
    @mutex.synchronize do
      id ||= SecureRandom.uuid
      duplicate = @templates.values.find { |t| t[:name].downcase == name.downcase && t[:id] != id }
      raise "Template name '#{name}' is already taken" if duplicate
      @templates[id] = {
        id: id,
        name: name,
        template: template,
        review_section_ids: review_section_ids.map(&:to_s).select { |section_id| @review_sections.key?(section_id) },
        color: color,
        work_dir: work_dir
      }
      bump_version
      id
    end
  end

  def delete_template(id)
    @mutex.synchronize do
      @templates.delete(id)
      bump_version
    end
  end

  # --- Chat ---

  def send_chat(task_id, message)
    task = nil
    @mutex.synchronize do
      task = @tasks[task_id]
      return nil unless task
      return nil unless [:completed, :failed, :reviewing].include?(task[:status])

      task[:chat_history] << {
        role: :user, content: message, timestamp: Time.now.iso8601,
        status: :pending
      }
      bump_version
    end

    Thread.new do
      begin
        dir = resolve_work_dir(task)
        output, _status = Open3.capture2e(
          child_process_env,
          @agent_cmd, *@agent_args, "-r", task[:session_id],
          "-p", message, "--max-thinking-tokens", "31999",
          chdir: dir
        )
        output = clean_output(output)

        @mutex.synchronize do
          # Update the pending message status
          pending = task[:chat_history].find { |m| m[:status] == :pending && m[:content] == message }
          pending[:status] = :sent if pending

          task[:chat_history] << {
            role: :assistant, content: output, timestamp: Time.now.iso8601
          }
          bump_version
        end
      rescue => e
        @mutex.synchronize do
          task[:chat_history] << {
            role: :system, content: "Error: #{e.message}", timestamp: Time.now.iso8601
          }
          bump_version
        end
      end
    end

    true
  end

  private

  def bump_version
    @version += 1
    maybe_save
  end

  def maybe_save
    return if @version == @last_saved_version
    return if Time.now - @last_save_time < SAVE_INTERVAL
    save_state
  end

  def save_state
    data = {
      tasks: @tasks.transform_values { |t| persist_task(t) },
      task_order: @task_order,
      review_sections: @review_sections,
      templates: @templates,
      paused: @paused
    }
    FileUtils.mkdir_p(File.dirname(PERSIST_FILE))
    tmp = "#{PERSIST_FILE}.tmp"
    File.write(tmp, JSON.pretty_generate(data))
    File.rename(tmp, PERSIST_FILE)
    @last_saved_version = @version
    @last_save_time = Time.now
  rescue => e
    $stderr.puts "[persist] save error: #{e.message}"
  end

  def persist_task(t)
    {
      id: t[:id], prompt: t[:prompt], label: t[:label],
      status: t[:status].to_s, output: t[:output],
      session_id: t[:session_id], exit_status: t[:exit_status],
      started_at: t[:started_at]&.iso8601,
      completed_at: t[:completed_at]&.iso8601,
      created_at: t[:created_at]&.iso8601,
      review_prompts: t[:review_prompts],
      review_output: t[:review_output],
      review_entries: t[:review_entries],
      chat_history: t[:chat_history],
      failure_details: t[:failure_details],
      color: t[:color],
      template_id: t[:template_id]
    }
  end

  def load_config
    return unless File.exist?(CONFIG_FILE)
    raw = JSON.parse(File.read(CONFIG_FILE), symbolize_names: true)
    @max_parallel = raw[:max_parallel] if raw[:max_parallel]
    @agent_cmd = raw[:agent_cmd] if raw[:agent_cmd]
    @agent_args = raw[:agent_args] if raw[:agent_args]
    @work_dir = raw[:work_dir] if raw[:work_dir]
    @session_viewer_url = raw[:session_viewer_url] if raw[:session_viewer_url]
    @allowed_hosts = raw[:allowed_hosts] if raw[:allowed_hosts]
  rescue => e
    $stderr.puts "[config] load error: #{e.message}"
  end

  def save_config
    data = {
      max_parallel: @max_parallel,
      agent_cmd: @agent_cmd,
      agent_args: @agent_args,
      work_dir: @work_dir,
      session_viewer_url: @session_viewer_url,
      allowed_hosts: @allowed_hosts
    }
    tmp = "#{CONFIG_FILE}.tmp"
    File.write(tmp, JSON.pretty_generate(data))
    File.rename(tmp, CONFIG_FILE)
  rescue => e
    $stderr.puts "[config] save error: #{e.message}"
  end

  def load_state
    return unless File.exist?(PERSIST_FILE)

    raw = JSON.parse(File.read(PERSIST_FILE), symbolize_names: true)

    @review_sections = {}
    if raw[:review_sections]
      raw[:review_sections].each do |k, v|
        id = (v[:id] || k).to_s
        @review_sections[id] = {
          id: id,
          name: v[:name].to_s,
          prompt: v[:prompt]
        }
      end
    end
    @paused = raw[:paused] if raw.key?(:paused)

    # Restore templates
    if raw[:templates]
      @templates = {}
      raw[:templates].each do |k, v|
        key = k.to_s
        @templates[key] = {
          id: v[:id] || key,
          name: v[:name],
          template: v[:template],
          review_section_ids: (v[:review_section_ids] || []).map(&:to_s).select { |id| @review_sections.key?(id) },
          color: v[:color],
          work_dir: v[:work_dir]
        }
      end
    end

    # Restore tasks. Tasks that were running/reviewing when the server died stay
    # as interrupted terminal states; they are not automatically restarted.
    if raw[:tasks]
      @task_order = raw[:task_order]&.map(&:to_s) || []
      raw[:tasks].each do |k, t|
        id = k.to_s
        status = t[:status].to_sym
        if [:running, :reviewing].include?(status)
          status = :failed
          t[:completed_at] ||= Time.now.iso8601
          t[:failure_details] ||= "Task was interrupted by server shutdown."
        end

        restored_task = build_task(
          id: id,
          prompt: t[:prompt],
          label: t[:label],
          status: status,
          output: t[:output] || "",
          session_id: t[:session_id] || SecureRandom.uuid,
          exit_status: t[:exit_status],
          started_at: t[:started_at] ? Time.parse(t[:started_at]) : nil,
          completed_at: t[:completed_at] ? Time.parse(t[:completed_at]) : nil,
          created_at: t[:created_at] ? Time.parse(t[:created_at]) : Time.now,
          review_prompts: t[:review_prompts] || [],
          review_output: t[:review_output],
          review_entries: t[:review_entries] || [],
          failure_details: t[:failure_details],
          color: t[:color],
          template_id: t[:template_id],
          chat_history: (t[:chat_history] || []).map { |m|
            m.transform_keys(&:to_sym).tap { |h| h[:role] = h[:role].to_sym if h[:role] }
          }
        )

        if restored_task[:failure_details].nil? && [:failed, :cancelled].include?(restored_task[:status])
          restored_task[:failure_details] = fallback_failure_details(restored_task)
        end

        @tasks[id] = restored_task
      end
      # Remove any task_order entries that don't exist in tasks
      @task_order.select! { |id| @tasks.key?(id) }
    end

    @version = 1
    @last_saved_version = @version
    @last_save_time = Time.now

    puts "[persist] loaded #{@tasks.size} tasks, #{@templates.size} templates"
  rescue => e
    $stderr.puts "[persist] load error: #{e.message}"
  end

  def state_unlocked
    queued = []
    running = []
    completed = []

    @task_order.each do |id|
      t = @tasks[id]
      case t[:status]
      when :queued
        queued << serialize_task(t)
      when :running, :reviewing
        running << serialize_task(t, include_output_tail: true)
      when :completed, :failed, :cancelled
        completed << serialize_task(t)
      end
    end

    {
      version: @version,
      paused: @paused,
      max_parallel: @max_parallel,
      queue: queued,
      workers: running,
      results: completed,
      stats: {
        queued: queued.size,
        running: running.size,
        completed: completed.count { |t| t[:status] == 'completed' },
        failed: completed.count { |t| t[:status] == 'failed' },
        cancelled: completed.count { |t| t[:status] == 'cancelled' }
      }
    }
  end

  def serialize_task(t, full: false, include_output_tail: false)
    h = {
      id: t[:id], prompt: t[:prompt], label: t[:label],
      status: t[:status].to_s, session_id: t[:session_id],
      exit_status: t[:exit_status],
      started_at: t[:started_at]&.iso8601,
      completed_at: t[:completed_at]&.iso8601,
      created_at: t[:created_at]&.iso8601,
      chat_count: t[:chat_history].size,
      has_review: !t[:review_output].nil?,
      summary: summarize_output(t[:failure_details] || t[:output]),
      color: t[:color],
      template_id: t[:template_id]
    }

    if full
      h[:output] = t[:output]
      h[:review_prompts] = t[:review_prompts]
      h[:review_output] = t[:review_output]
      h[:review_entries] = t[:review_entries]
      h[:chat_history] = t[:chat_history]
      h[:failure_details] = t[:failure_details]
    elsif include_output_tail
      h[:output_tail] = t[:output].length > 500 ? t[:output][-500..] : t[:output]
      h[:output_length] = t[:output].length
    end

    h
  end

  def monitor_loop
    while @running
      @mutex.synchronize do
        read_outputs
        check_completions
        fill_pool unless @paused
        maybe_save
      end
      sleep 0.3
    end
  end

  def read_outputs
    running_tasks.each do |task|
      next unless task[:reader]
      begin
        loop do
          chunk = task[:reader].read_nonblock(8192)
          task[:output] << chunk
          bump_version
        end
      rescue IO::WaitReadable
        # no more data right now
      rescue EOFError
        # pipe closed
      end
    end
  end

  def check_completions
    running_tasks.each do |task|
      begin
        result = Process.waitpid(task[:pid], Process::WNOHANG)
        next unless result

        status = $?
        handle_completion(task, status)
      rescue Errno::ECHILD
        handle_completion(task, nil)
      end
    end
  end

  def handle_completion(task, status)
    task[:reader]&.close rescue nil
    task[:reader] = nil
    task[:pid] = nil
    task[:exit_status] = status&.exitstatus
    task[:completed_at] = Time.now
    task[:output] = clean_output(task[:output])

    if task[:cancel_requested]
      task[:status] = :cancelled
      task[:failure_details] = "Task was cancelled."
      bump_version
      return
    end

    task[:failure_details] = derive_failure_details(task, status)

    if task[:review_prompts].any?
      task[:status] = :reviewing
      bump_version
      Thread.new { run_reviews(task) }
    else
      task[:status] = status&.exitstatus == 0 ? :completed : :failed
      bump_version
    end
  end

  def run_reviews(task)
    results = []
    entries = []
    dir = resolve_work_dir(task)
    task[:review_prompts].each do |prompt|
      output, _status = Open3.capture2e(
        child_process_env,
        @agent_cmd, *@agent_args, "-r", task[:session_id],
        "-p", prompt, "--max-thinking-tokens", "31999",
        chdir: dir
      )
      output = clean_output(output)
      entries << { prompt: prompt, output: output }
      results << "**#{prompt}**\n\n#{output}"
    end

    @mutex.synchronize do
      if task[:cancel_requested]
        task[:status] = :cancelled
        task[:failure_details] = "Task was cancelled during review."
        bump_version
        return
      end

      task[:review_entries] = entries
      task[:review_output] = results.join("\n\n---\n\n")
      task[:status] = task[:exit_status] == 0 ? :completed : :failed
      bump_version
    end
  rescue => e
    @mutex.synchronize do
      if task[:cancel_requested]
        task[:status] = :cancelled
        task[:failure_details] = "Task was cancelled during review."
        bump_version
        return
      end

      task[:review_output] = "Review error: #{e.message}"
      task[:review_entries] = []
      task[:status] = :failed
      task[:failure_details] = [task[:failure_details], task[:review_output]].compact.join("\n\n")
      bump_version
    end
  end

  def fill_pool
    active_count = active_slot_tasks.size
    while active_count < @max_parallel
      queued = @task_order.find { |id| @tasks[id][:status] == :queued }
      break unless queued
      spawn_task(@tasks[queued])
      active_count += 1
    end
  end

  def spawn_task(task)
    reader, writer = IO.pipe
    begin
      opts = { out: writer, err: writer }
      dir = resolve_work_dir(task)
      opts[:chdir] = dir if dir
      pid = Process.spawn(
        child_process_env,
        @agent_cmd, *@agent_args, "-p", task[:prompt],
        "--max-thinking-tokens", "31999",
        "--session-id", task[:session_id],
        **opts
      )
      writer.close

      task[:pid] = pid
      task[:status] = :running
      task[:started_at] = Time.now
      task[:reader] = reader
      bump_version
    rescue => e
      writer.close rescue nil
      reader.close rescue nil
      task[:pid] = nil
      task[:reader] = nil
      task[:status] = :failed
      task[:started_at] ||= Time.now
      task[:completed_at] = Time.now
      task[:output] = "Spawn error: #{e.message}"
      task[:failure_details] = task[:output]
      bump_version
    end
  end

  def active_slot_tasks
    @task_order
      .map { |id| @tasks[id] }
      .select { |t| [:running, :reviewing].include?(t[:status]) }
  end

  def running_tasks
    @task_order
      .map { |id| @tasks[id] }
      .select { |t| t[:status] == :running && t[:pid] }
  end

  def build_task(id:, prompt:, label:, created_at:, status: :queued, output: "",
                 session_id: nil, exit_status: nil, started_at: nil,
                 completed_at: nil, review_prompts: [], review_output: nil, failure_details: nil,
                 review_entries: [], chat_history: [], color: nil, template_id: nil)
    {
      id: id,
      prompt: prompt,
      label: label,
      status: status,
      output: output,
      session_id: session_id || SecureRandom.uuid,
      pid: nil,
      exit_status: exit_status,
      started_at: started_at,
      completed_at: completed_at,
      created_at: created_at,
      review_prompts: review_prompts,
      reader: nil,
      review_output: review_output,
      review_entries: review_entries,
      failure_details: failure_details,
      chat_history: chat_history,
      cancel_requested: false,
      color: color,
      template_id: template_id
    }
  end

  def derive_failure_details(task, status)
    return nil if status&.exitstatus == 0

    cleaned_output = clean_output(task[:output])
    return cleaned_output unless cleaned_output.empty?

    if status.nil?
      "Task failed without an exit status."
    else
      "Task failed with exit code #{status.exitstatus}."
    end
  end

  def fallback_failure_details(task)
    cleaned_output = clean_output(task[:output])
    return cleaned_output unless cleaned_output.empty?

    return "Task was cancelled." if task[:status] == :cancelled

    if task[:exit_status]
      "Task failed with exit code #{task[:exit_status]}."
    else
      "Task failed without a recorded error message."
    end
  end

  def clean_output(str)
    str.to_s.gsub(/\e(?:\[[0-9;?<>=]*[a-zA-Z]|\][^\a]*\a)/, '').delete("\r").strip
  end

  def summarize_output(output)
    text = clean_output(output)
    return nil if text.empty?

    lines = text.lines.map(&:strip).reject do |line|
      line.empty? || line.match?(/\A[-*_`#>\s]+\z/)
    end
    return nil if lines.empty?

    preferred = lines.reverse.find do |line|
      line.match?(/\b(error|failed|exception|spawn error|not found|denied)\b/i)
    end

    summary = preferred || lines.first
    summary.length > 160 ? "#{summary[0...157]}..." : summary
  end

  # Resolve the working directory for a task: per-task override (from template)
  # falls back to the global work_dir setting.
  def resolve_work_dir(task)
    tmpl = task[:template_id] ? @templates[task[:template_id]] : nil
    tmpl_dir = tmpl[:work_dir] if tmpl && tmpl[:work_dir].to_s != ''
    dir = tmpl_dir || @work_dir
    raise "Working directory is not configured" if dir.to_s.strip.empty?
    FileUtils.mkdir_p(dir)
    dir
  end

  # ClaudeHive runs under `bundle exec`, which sets BUNDLE_PATH, BUNDLE_GEMFILE,
  # RUBYOPT, GEM_HOME, etc. If these leak into the agent command's process tree,
  # child Ruby processes may load the wrong Bundler config. This method builds a
  # clean env using Bundler.unbundled_env, then converts absent keys to nil so
  # Process.spawn actually unsets them (it only unsets keys explicitly set to nil,
  # not keys missing from the hash).
  def child_process_env
    env = Bundler.unbundled_env
    ENV.each_key { |k| env[k] = nil unless env.key?(k) }
    env
  end
end
