# acon serve (H1) image. Holds no credentials: configure auth with ACON_ACCESS_TEAM/ACON_ACCESS_AUD
# or a mounted ACON_TOKEN_FILE, and the browser origin with ACON_ORIGINS or --origin.
FROM oven/bun:1.4.3

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY bin ./bin
COPY src ./src
COPY shell ./shell
COPY README.md CHANGELOG.md LICENSE ./
# The image must not depend on the build context's file modes (a umask-077 checkout would leave /app unreadable).
RUN chmod -R a+rX,go-w /app

# Plugins, pets and asset packs live in the volume; the image's own files stay read-only for the app user.
ENV AGENTHUB_HOME=/data
ENV ACON_PORT=8787
RUN mkdir -p /data && chown bun:bun /data && chmod 700 /data
VOLUME ["/data"]
USER bun

EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.ACON_PORT || 8787}/healthz`); process.exit(r.status === 204 ? 0 : 1)"]

ENTRYPOINT ["bun", "bin/acon.js"]
CMD ["serve", "--host", "0.0.0.0"]
