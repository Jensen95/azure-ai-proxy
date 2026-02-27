FROM node:25-alpine AS builder
WORKDIR /app

# Install deps (including dev) to enable TypeScript compilation
COPY package*.json ./
RUN npm ci

# Copy TypeScript project files (will fail if src is missing, which is fine if you don't target this stage)
COPY tsconfig.json ./
COPY src ./src

# Compile TS -> JS (outputs to ./dist per tsconfig.json)
RUN npx tsc

############################
# Runtime (from builder): use compiled dist from the builder stage
############################
FROM node:25-alpine AS runtime
WORKDIR /app

# Install only production dependencies for lean runtime
COPY package*.json ./
RUN npm ci --omit=dev

# Bring compiled JS from builder
COPY --from=builder /app/dist ./dist

# App configuration
ENV NODE_ENV=production
ENV PORT=8000

# Non-root user included in official Node images
USER node

EXPOSE 8000
CMD ["node", "dist/azureAiProxy.js"]
