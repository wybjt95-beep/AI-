FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    APP_ENV=production \
    APP_DATA_DIR=/data \
    COOKIE_SECURE=true

WORKDIR /app
COPY . /app

RUN mkdir -p /data

EXPOSE 5176

CMD ["sh", "-c", "python server.py --host 0.0.0.0 --port ${PORT:-5176}"]
