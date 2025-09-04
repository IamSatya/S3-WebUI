from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import boto3
from botocore.config import Config
import os
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

AWS_REGION = os.getenv("AWS_REGION", "ap-south-1")
S3_BUCKET = os.getenv("S3_BUCKET")

s3_client = boto3.client(
    "s3",
    region_name=AWS_REGION,
    config=Config(signature_version="s3v4")
)

class FileRequest(BaseModel):
    filename: str
    filetype: str

@app.post("/api/generate_presigned_url")
def generate_presigned_url(request: FileRequest):
    presigned_url = s3_client.generate_presigned_url(
        "put_object",
        Params={"Bucket": S3_BUCKET, "Key": request.filename},
        ExpiresIn=3600,
    )
    return {"url": presigned_url}

@app.get("/api/list_files")
def list_files(prefix: str = ""):
    response = s3_client.list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix, Delimiter="/")
    files = []
    for folder in response.get("CommonPrefixes", []):
        files.append({
            "key": folder["Prefix"],
            "name": folder["Prefix"].split("/")[-2],
            "isFolder": True
        })
    for obj in response.get("Contents", []):
        if obj["Key"] != prefix:
            files.append({
                "key": obj["Key"],
                "name": obj["Key"].split("/")[-1],
                "size": obj["Size"],
                "last_modified": obj["LastModified"].isoformat(),
                "isFolder": False
            })
    return {"files": files}

@app.get("/api/download_file")
def download_file(key: str = Query(...)):
    presigned_url = s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": key},
        ExpiresIn=3600,
    )
    return {"url": presigned_url}

@app.delete("/api/delete_file")
def delete_file(key: str = Query(...)):
    s3_client.delete_object(Bucket=S3_BUCKET, Key=key)
    return {"message": f"{key} deleted successfully"}

@app.post("/api/create_folder")
def create_folder(prefix: str = Query(...)):
    if not prefix.endswith("/"):
        prefix += "/"
    s3_client.put_object(Bucket=S3_BUCKET, Key=prefix)
    return {"message": f"Folder '{prefix}' created successfully"}
