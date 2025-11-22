#!/bin/bash

# Setup database script
echo "Setting up database..."

# Create database if it doesn't exist
sudo docker exec -i scribeai-postgres psql -U scribeai -d postgres <<EOF
SELECT 'CREATE DATABASE scribeai_db'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'scribeai_db')\gexec
EOF

echo "Database setup complete!"
echo "Now run: npm run prisma:migrate"

