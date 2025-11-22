#!/bin/bash

# Fix DATABASE_URL in .env file
echo "Updating DATABASE_URL in .env file..."

# Backup existing .env
if [ -f .env ]; then
  cp .env .env.backup
  echo "Backed up .env to .env.backup"
fi

# Update DATABASE_URL
if [ -f .env ]; then
  # Remove old DATABASE_URL line
  sed -i '/^DATABASE_URL=/d' .env
  
  # Add correct DATABASE_URL at the beginning
  sed -i '1i DATABASE_URL="postgresql://scribeai:scribeai_password@localhost:5432/scribeai_db?schema=public"' .env
  
  echo "✅ Updated DATABASE_URL to:"
  echo "   postgresql://scribeai:scribeai_password@localhost:5432/scribeai_db?schema=public"
else
  echo "Creating new .env file..."
  cat > .env <<EOF
# Database
DATABASE_URL="postgresql://scribeai:scribeai_password@localhost:5432/scribeai_db?schema=public"

# Better Auth
BETTER_AUTH_SECRET="change-this-to-a-random-secret-key-in-production"
BETTER_AUTH_URL="http://localhost:3000"

# Gemini API
GEMINI_API_KEY="your-gemini-api-key-here"

# WebSocket Server
WEBSOCKET_URL="http://localhost:4000"
FRONTEND_URL="http://localhost:3000"
EOF
  echo "✅ Created .env file"
fi

echo ""
echo "Now run: npm run prisma:migrate"

