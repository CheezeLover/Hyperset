FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Pages directory is mounted at runtime — not baked into the image
VOLUME ["/pages"]

EXPOSE 8000

CMD ["python", "main.py"]
