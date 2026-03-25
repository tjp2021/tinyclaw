#!/opt/homebrew/bin/bash
# TinyClaw Installer - Fixes path issues and installs all dependencies

echo Installing TinyClaw dependencies...

# Install tmux if not present
if ! command -v tmux &> /dev/null; then
    echo Installing tmux...
    /opt/homebrew/bin/brew install tmux
fi

# Install bash 5 if not present
if ! /opt/homebrew/bin/brew list bash &> /dev/null; then
    echo Installing bash 5...
    /opt/homebrew/bin/brew install bash
fi

# Fix all tinyclaw scripts to use correct bash
echo Fixing TinyClaw scripts...
SCRIPT_DIR="$HOME/.tinyclaw"
if [ -d "$SCRIPT_DIR" ]; then
    # Fix main script
    sed -i '' '1s|#!/usr/bin/env bash|#!/opt/homebrew/bin/bash|' "$SCRIPT_DIR/tinyclaw.sh" 2>/dev/null
    
    # Fix all lib scripts
    for f in "$SCRIPT_DIR"/lib/*.sh; do
        if [ -f "$f" ]; then
            sed -i '' '1s|#!/usr/bin/env bash|#!/opt/homebrew/bin/bash|' "$f" 2>/dev/null
        fi
    done
    
    # Fix all channel scripts
    if [ -d "$SCRIPT_DIR/channels" ]; then
        for f in "$SCRIPT_DIR/channels"/*.sh; do
            if [ -f "$f" ]; then
                sed -i '' '1s|#!/usr/bin/env bash|#!/opt/homebrew/bin/bash|' "$f" 2>/dev/null
            fi
        done
    fi
fi

# Install Claude Code if not present
if ! command -v claude &> /dev/null; then
    echo Installing Claude Code...
    /opt/homebrew/bin/brew install --cask claude-code
fi

echo 
echo Done! To start TinyClaw:
echo  /Users/tim/.tinyclaw/tinyclaw.sh start
