#!/bin/bash

# ScribeAI Setup Script
# This script sets up the development environment

set -e

echo "🚀 Setting up ScribeAI..."

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Start Postgres database
echo "📦 Starting Postgres database..."
docker-compose up -d

# Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
sleep 5

# Install dependencies
echo "📥 Installing dependencies..."
npm install
cd server && npm install && cd ..

# Generate Prisma Client
echo "🔧 Generating Prisma Client..."
npm run prisma:generate

# Run database migrations
echo "🗄️  Running database migrations..."
npm run prisma:migrate

echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Create a .env file with your configuration (see .env.example)"
echo "2. Add your GEMINI_API_KEY to .env"
echo "3. Run 'npm run dev' to start the development servers"
echo ""
echo "The application will be available at:"
echo "  - Frontend: http://localhost:3000"
echo "  - WebSocket Server: http://localhost:4000"

