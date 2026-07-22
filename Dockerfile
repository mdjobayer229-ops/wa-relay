FROM node:20-slim
RUN apt-get update -qq && apt-get install -y -qq git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production
COPY . .
EXPOSE 8080
CMD ["node", "index.mjs"]
