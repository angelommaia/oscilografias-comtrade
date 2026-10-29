FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY static/ ./static/
COPY samples/ ./samples/

ENV ENV=production
ENV PYTHONUNBUFFERED=1

WORKDIR /app/backend

CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
