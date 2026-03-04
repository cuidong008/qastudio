# ========== 阶段一：构建前端 ==========
FROM node:22.22-alpine AS frontend-builder

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# 生产环境与后端同源，API 使用相对路径 /api
ENV VITE_API_BASE=/api
RUN npm run build

# ========== 阶段二：运行后端并托管前端静态资源 ==========
FROM python:3.12-slim

WORKDIR /app

# 系统依赖（MinerU/PDF 等可选）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# 将前端构建产物放入后端 static 目录，由 FastAPI 托管
COPY --from=frontend-builder /app/frontend/dist ./static

# 数据与上传目录（可通过卷挂载持久化）
ENV UPLOAD_DIR=/data/uploads
ENV DATABASE_URL=sqlite+aiosqlite:////data/qastudio.db
ENV RAG_VECTOR_STORE_PATH=/data/rag_vector_store

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
