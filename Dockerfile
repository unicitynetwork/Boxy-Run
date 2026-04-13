FROM node:20-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npx esbuild tournament/server/server-v2.ts --bundle --outfile=dist/server.js --platform=node --format=cjs --packages=external

FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev 2>/dev/null || npm ci
COPY --from=build /app/dist/server.js ./dist/server.js
COPY --from=build /app/js ./js
COPY --from=build /app/index.html ./
COPY --from=build /app/tournament.html ./
COPY --from=build /app/tournament-v2.html ./
COPY --from=build /app/leaderboard.html ./
COPY --from=build /app/display.html ./
COPY --from=build /app/style.css ./
COPY --from=build /app/logo.png ./
COPY --from=build /app/unicity-logo.png ./
COPY --from=build /app/dev.html ./

ENV PORT=8080
ENV STATIC_DIR=/app
ENV DB_PATH=/data/boxyrun.db

EXPOSE 8080
CMD ["node", "dist/server.js"]
