# -------------------
# Base builder stage
# -------------------
FROM node:20-alpine AS base

WORKDIR /usr/src/app

# Install system dependencies needed for building native modules
RUN apk add --no-cache bash python3 g++ make openssl

# Copy package and config files
COPY package*.json tsconfig.json ./

# Install dependencies (using ci for lockfile integrity)
RUN npm ci

# Copy Prisma schema and generate client
COPY prisma ./prisma/
RUN npx prisma generate

# Copy source
COPY . .

# -------------------
# Build stage (for production)
# -------------------
FROM base AS builder
RUN npm run build

# -------------------
# Runtime stage
# -------------------
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

RUN apk add --no-cache openssl

# Copy from builder
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/prisma ./prisma
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /usr/src/app/dist ./dist

# Create logs directory with proper permissions BEFORE switching to non-root user
RUN mkdir -p logs && chmod 755 logs

# Non-root user for security
RUN addgroup -S appuser && adduser -S appuser -G appuser

# Change ownership of the entire app directory including logs
RUN chown -R appuser:appuser /usr/src/app

USER appuser

# Environment variable toggle
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# -------------------
# Conditional command
# -------------------
# If NODE_ENV=development, run TS directly with ts-node + nodemon
# Else, run the compiled JS version.
CMD ["sh", "-c", "if [ \"$NODE_ENV\" = \"development\" ]; then npx nodemon --watch src -e ts --exec npx ts-node src/server.ts; else npx prisma migrate deploy && npm run start:prod; fi"]