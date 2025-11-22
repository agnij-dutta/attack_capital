#!/bin/bash

# Check if database is accessible
echo "Checking database connection..."

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set"
  exit 1
fi

echo "DATABASE_URL: $DATABASE_URL"

# Try to connect using psql if available
if command -v psql &> /dev/null; then
  echo "Testing connection with psql..."
  psql "$DATABASE_URL" -c "SELECT 1;" 2>&1
else
  echo "psql not available, skipping direct connection test"
fi

echo ""
echo "To start the database:"
echo "  docker-compose up -d"
echo ""
echo "To run migrations:"
echo "  npm run prisma:migrate"

