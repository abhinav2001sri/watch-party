# Generic container image — works on Railway, Fly.io, Render (Docker), any VPS.
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
RUN npm install

# Copy the rest of the source and build the frontend.
COPY . .
RUN npm run build

# The server reads process.env.PORT; expose the default for local docker runs.
ENV PORT=3001
EXPOSE 3001

CMD ["npm", "start"]
