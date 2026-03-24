# ClaudeHive

A web UI and CLI for running Claude agents in parallel — batch tasks, review results, and follow up with agents, all from one place.

<video src="demo.mp4" autoplay loop muted playsinline></video>

If you've ever needed to run the same Claude agent task across a dozen inputs and then review every result — you know the pain. Switching between terminal tabs, losing track of which session was which, scrolling through output trying to find the one that matters. And then a week later, trying to find that one session where the agent found something interesting? Forget it.

ClaudeHive gives you a single place to manage all of it. Queue up tasks, watch them run in parallel, inspect results, and have follow-up conversations with any agent — without losing your mind or your session history.

And here's the part that really excites me: there's a CLI tool. Which means your agent can use it too. Give an agent access to `claudehive` and it can spawn worker agents, wait for them to finish, read their results, send follow-ups — effectively delegating work to a team of agents and coordinating them. It's like giving your agent the ability to hire teammates.

## How It Works

**Templates** define reusable prompts with an `%{input}` placeholder. Optionally attach **review sections** — self-review questions the agent answers after completing the task.

Create a batch by picking a template and providing inputs. ClaudeHive creates one task per input, runs them in parallel (configurable concurrency), and collects results.

Once a task completes, you can:
- Inspect the output and review answers
- Send follow-up messages (chat-style conversation with the agent)
- View the agent's full session (tool calls, thinking, etc.) — requires [claude-code-lens](https://github.com/ertygiq/claude-code-lens) to be installed separately

### Under the Hood

Each task spawns a Claude Code CLI process with a randomly generated session ID. This session ID is the key to everything — it's how ClaudeHive resumes the conversation for reviews and follow-ups:

```bash
# Initial task
claude -p "your prompt" --session-id abc123

# Self-review (after task completes)
claude -r abc123 -p "Did you cover the requested points?"

# Follow-up conversation
claude -r abc123 -p "Can you expand on the third item?"
```

## Setup

Prerequisites: Ruby, Bundler, [Claude Code](https://claude.ai/claude-code).

```bash
git clone https://github.com/ertygiq/claude-hive.git
cd claude-hive
bundle install
./start.sh
```

Custom port:

```bash
PORT=8080 ./start.sh
```

Open `http://localhost:4567` (or your custom port). Configure the agent command and templates in the settings panel (gear icon).

### Permissions

Tasks run with `claude -p`, which means Claude operates in headless mode with no interactive permission prompts — by default it can only read files. If your tasks need Claude to write files, run commands, or use tools, add `--dangerously-skip-permissions` to the agent args in settings.

**Be careful with this.** It gives Claude unrestricted access to your system. Consider running in a sandboxed environment or a Docker container. Alternatively, you can set fine-grained permissions in `.claude/settings.json` inside the working directory instead of skipping all permissions.

## CLI

ClaudeHive includes a command-line client. Symlink it into your PATH:

```bash
ln -s "$(pwd)/claudehive" ~/.local/bin/claudehive
```

```bash
claudehive status                      # queue/running/completed counts
claudehive templates                   # list prompt templates
claudehive start <template> <input>    # start task from template
claudehive start -p "prompt"           # start with raw prompt
claudehive queue                       # queued + running tasks
claudehive results                     # completed tasks
claudehive show <id>                   # task output
claudehive show <id> --review          # review sections only
claudehive show <id> --followup        # follow-up messages only
claudehive show <id> --full            # everything
claudehive wait <id>                   # block until task completes
claudehive followup <id> "message"     # send follow-up message
claudehive cancel <id>                 # cancel a task
claudehive retry <id>                  # retry a task
```

Task IDs can be shortened to a unique prefix (e.g. `4f63e134` instead of the full UUID).

Override the server address in `~/.config/claudehive.json`:

```json
{"host": "http://localhost:4567"}
```

## License

MIT
