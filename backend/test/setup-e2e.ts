// Force in-memory SQLite for all e2e tests — never touch the real database.
process.env.DATABASE_URL = ':memory:';
process.env.NODE_ENV = 'development';
