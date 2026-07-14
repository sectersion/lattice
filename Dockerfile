FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
ENV DB_PATH=/data/threads.db
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/index.js"]
