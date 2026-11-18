FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV DATA_DIR=/data \
    PORT=3000 \
    AP_DIR=/opt/Archipelago \
    AP_PYTHON=/opt/ap-venv/bin/python

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/opt/app/scripts/entrypoint.sh"]
