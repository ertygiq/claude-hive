# frozen_string_literal: true

require 'sinatra/base'
require 'sinatra/json'
require 'json'
require 'uri'
require_relative 'lib/pool_manager'

class ClaudeHiveApp < Sinatra::Base
  set :port, ENV.fetch('PORT', 4567).to_i
  set :bind, '127.0.0.1'
  set :public_folder, File.join(__dir__, 'public')
  set :pool, PoolManager.new

  JSON_METHODS = %w[POST PUT PATCH].freeze
  UNSAFE_METHODS = %w[POST PUT PATCH DELETE].freeze

  configure do
    settings.pool.start
    set :static_cache_control, [:no_cache, :no_store, :must_revalidate]
  end

  at_exit do
    settings.pool.stop
  end

  before do
    # Validate Host on every request to block DNS rebinding, and require a
    # trusted browser origin for state-changing requests to block CSRF.
    allowed = pool.config[:allowed_hosts] || %w[localhost 127.0.0.1]
    host = request.host
    halt 403, json(error: "Blocked: untrusted Host header '#{host}'") unless allowed.include?(host)

    if UNSAFE_METHODS.include?(request.request_method)
      halt 403, json(error: "Blocked: untrusted request origin") unless trusted_request_origin?(allowed)
    end

    if JSON_METHODS.include?(request.request_method)
      unless request.media_type == 'application/json'
        halt 415, json(error: "Content-Type must be application/json")
      end
    end
  end

  helpers do
    def pool
      settings.pool
    end

    def trusted_request_origin?(allowed_hosts)
      origin = request.env['HTTP_ORIGIN']
      return origin_allowed?(origin, allowed_hosts) if origin && !origin.empty?

      referer = request.referer
      return origin_allowed?(referer, allowed_hosts) if referer && !referer.empty?

      false
    end

    def origin_allowed?(value, allowed_hosts)
      uri = URI.parse(value)
      return false unless uri.host
      return false unless %w[http https].include?(uri.scheme)

      allowed_hosts.include?(uri.host) && same_effective_port?(uri)
    rescue URI::InvalidURIError
      false
    end

    def same_effective_port?(uri)
      uri_port = uri.port || (uri.scheme == 'https' ? 443 : 80)
      uri_port == request.port
    end

    def parse_body
      JSON.parse(request.body.read, symbolize_names: true)
    rescue JSON::ParserError
      halt 400, json(error: "Invalid JSON")
    end
  end

  # --- Pages ---

  get '/' do
    send_file File.join(settings.public_folder, 'index.html')
  end

  # --- State ---

  get '/api/state' do
    json pool.state
  end

  get '/api/tasks/:id' do
    detail = pool.task_detail(params[:id])
    halt 404, json(error: "Not found") unless detail
    json detail
  end

  # --- Task management ---

  post '/api/tasks' do
    body = parse_body
    id = pool.add_task(prompt: body[:prompt], label: body[:label])
    json(id: id)
  end

  post '/api/tasks/batch' do
    body = parse_body
    ids = pool.add_tasks_batch(
      inputs: body[:inputs],
      template_id: body[:template_id]
    )
    json(ids: ids)
  end

  delete '/api/tasks/:id' do
    pool.remove_task(params[:id])
    json(ok: true)
  end

  post '/api/tasks/:id/cancel' do
    result = pool.cancel_task(params[:id])
    halt 409, json(error: "Task cannot be cancelled in its current state") unless result
    json(ok: true)
  end

  post '/api/tasks/cancel_all' do
    count = pool.cancel_all_tasks
    json(ok: true, cancelled: count)
  end

  post '/api/tasks/:id/retry' do
    pool.retry_task(params[:id])
    json(ok: true)
  end

  post '/api/tasks/:id/chat' do
    body = parse_body
    result = pool.send_chat(params[:id], body[:message])
    halt 400, json(error: "Cannot chat with this task") unless result
    json(ok: true)
  end

  post '/api/queue/reorder' do
    body = parse_body
    pool.reorder_queue(body[:order])
    json(ok: true)
  end

  post '/api/completed/clear' do
    count = pool.clear_completed
    json(cleared: count)
  end

  # --- Controls ---

  post '/api/control/pause' do
    pool.pause
    json(paused: true)
  end

  post '/api/control/resume' do
    pool.resume
    json(paused: false)
  end

  # --- Config ---

  get '/api/config' do
    json pool.config
  end

  put '/api/config' do
    body = parse_body
    begin
      pool.update_config(body)
      json(ok: true)
    rescue RuntimeError => e
      halt 400, json(error: e.message)
    end
  end

  # --- Templates ---

  post '/api/templates' do
    body = parse_body
    begin
      id = pool.save_template(
        id: body[:id],
        name: body[:name],
        template: body[:template],
        review_section_ids: body[:review_section_ids] || [],
        color: body[:color],
        work_dir: body[:work_dir]
      )
      json(id: id)
    rescue RuntimeError => e
      halt 409, json(error: e.message)
    end
  end

  delete '/api/templates/:id' do
    pool.delete_template(params[:id])
    json(ok: true)
  end

  run! if app_file == $0
end
