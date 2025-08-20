# -------------------
# Build stage
# -------------------
FROM node:20 AS builder

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy Prisma schema
COPY prisma ./prisma/

# Generate Prisma client for Linux
RUN npx prisma generate

# Copy source code and build
COPY . .
RUN npm run build

# -------------------
# Runtime stage
# -------------------
FROM node:20-slim AS runner

# Install OpenSSL (required for Prisma)
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package files
COPY --from=builder /usr/src/app/package*.json ./

# Copy built application
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/prisma ./prisma

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Generate Prisma client in the runtime environment
RUN npx prisma generate

# Create non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser
RUN chown -R appuser:appuser /usr/src/app
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Run migrations and start server
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start:prod"]