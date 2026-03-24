#!/bin/bash
# Start ClaudeHive
# Usage: ./start.sh
# Environment variables:
#   PORT - server port (default: 4567)

cd "$(dirname "$0")"

[ -f config.json ] || cp config.json.example config.json

echo "Starting ClaudeHive on http://localhost:${PORT:-4567}"
bundle exec ruby app.rb
