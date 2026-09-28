FROM node:22-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY index.mjs log-call.mjs .
ENTRYPOINT ["node", "index.mjs"]
