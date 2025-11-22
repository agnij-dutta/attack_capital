# Database Setup Instructions

## Issue: Database Connection Failed

The error "Cannot fetch data from service: fetch failed" indicates that Prisma cannot connect to the PostgreSQL database.

## Quick Fix

1. **Start the database:**
   ```bash
   # If you have Docker installed and running:
   docker-compose up -d
   
   # Or if you need sudo:
   sudo docker-compose up -d
   ```

2. **Wait for database to be ready (5-10 seconds)**

3. **Run migrations:**
   ```bash
   npm run prisma:migrate
   ```

4. **Verify connection:**
   ```bash
   npm run prisma:studio
   # This should open Prisma Studio if the connection works
   ```

## Alternative: Use a Cloud Database

If Docker isn't available, you can use a cloud PostgreSQL service:

1. Get a free PostgreSQL database from:
   - [Supabase](https://supabase.com) (recommended)
   - [Neon](https://neon.tech)
   - [Railway](https://railway.app)

2. Update your `.env` file:
   ```env
   DATABASE_URL="postgresql://user:password@host:port/database?sslmode=require"
   ```

3. Run migrations:
   ```bash
   npm run prisma:migrate
   ```

## Check Current DATABASE_URL

Your current DATABASE_URL should be:
```
postgresql://scribeai:scribeai_password@localhost:5432/scribeai_db?schema=public
```

Make sure:
- Docker container is running on port 5432
- Database name is `scribeai_db`
- Username is `scribeai`
- Password is `scribeai_password`

