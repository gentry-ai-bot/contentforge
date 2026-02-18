FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ src/
EXPOSE 3000
CMD ["node", "src/index.js"]
