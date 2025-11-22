#!/bin/bash

echo "🔄 Restarting development servers..."

# Kill any existing processes
pkill -f "next dev" 2>/dev/null || true
pkill -f "tsx watch" 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
lsof -ti:4000 | xargs kill -9 2>/dev/null || true

echo "✅ Killed existing processes"

# Clear caches
rm -rf .next node_modules/.cache

echo "✅ Cleared caches"

# Wait a moment
sleep 2

echo "🚀 Starting dev servers..."
npm run dev

