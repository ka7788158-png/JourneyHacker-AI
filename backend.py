import os 
import certifi
from dotenv import load_dotenv

load_dotenv()

os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

from typing import TypedDict
import operator
import uuid

import psycopg
from psycopg.rows import dict_row

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.postgres import PostgresSaver
from langchain_core.messages import (
    AnyMessage, 
    HumanMessage, 
    AIMessage, 
    SystemMessage
)

from langchain_groq import ChatGroq
from tools.tavily_tool import tavily_search
# from tools.flight_tool import search_flights

def get_database_url():
    database_url = os.getenv("DATABASE_URL")

    if not database_url:
        raise ValueError(
            "DATABASE_UR; is missing. Please add your Render PostgreSQL External Database"
        )

    if "sslmode=" not in database_url: 
        separator = "&" if "?" in database_url else "?"
        database_url  = f"{database_url}{separator}sslmode=require"
        # we are actually adding sslmode=require at the last of our database url
        # because we are going to be connected to our remote database server

    return database_url


url = get_database_url()
print(url)
