"""
Elasticsearch client for FERRET
Handles storage and retrieval of HTTP requests and responses
"""

import json
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from elasticsearch import AsyncElasticsearch
from elasticsearch.exceptions import ConnectionError, NotFoundError

from models import HttpRequest, SearchFilter, ElasticsearchConfig

class ElasticsearchClient:
    """Elasticsearch client for storing and searching HTTP requests"""
    
    def __init__(self, config: Optional[ElasticsearchConfig] = None):
        self.config = config or ElasticsearchConfig()
        self.client: Optional[AsyncElasticsearch] = None
        self.index_name = self.config.index_name

    async def initialize(self):
        """Initialize Elasticsearch connection and setup indices"""
        try:
            # Create Elasticsearch client with proper URL scheme
            scheme = "https" if self.config.use_ssl else "http"
            elasticsearch_url = f"{scheme}://{self.config.host}:{self.config.port}"
            
            client_config = {
                'hosts': [elasticsearch_url],
                'verify_certs': self.config.verify_certs,
            }
            
            if self.config.use_ssl:
                client_config['use_ssl'] = True
                
            if self.config.username and self.config.password:
                client_config['http_auth'] = (self.config.username, self.config.password)
                
            self.client = AsyncElasticsearch(**client_config)
            
            # Test connection
            await self.client.ping()
            print(f"Connected to Elasticsearch at {self.config.host}:{self.config.port}")
            
            # Create index if it doesn't exist
            await self._create_index_if_not_exists()
            
        except ConnectionError as e:
            print(f"Failed to connect to Elasticsearch: {e}")
            raise
        except Exception as e:
            print(f"Error initializing Elasticsearch: {e}")
            raise

    async def _create_index_if_not_exists(self):
        """Create the requests index with proper mapping if it doesn't exist"""
        if await self.client.indices.exists(index=self.index_name):
            return
            
        # Define index mapping
        mapping = {
            "mappings": {
                "properties": {
                    "id": {"type": "keyword"},
                    "timestamp": {"type": "date"},
                    "method": {"type": "keyword"},
                    "url": {"type": "text", "analyzer": "standard"},
                    "host": {"type": "keyword"},
                    "path": {"type": "text", "analyzer": "standard"},
                    "query_params": {"type": "object"},
                    "headers": {"type": "object"},
                    "body": {"type": "text", "analyzer": "standard"},
                    "content_type": {"type": "keyword"},
                    "content_length": {"type": "integer"},
                    "status_code": {"type": "integer"},
                    "response_headers": {"type": "object"},
                    "response_body": {"type": "text", "analyzer": "standard"},
                    "response_time": {"type": "float"},
                    "response_size": {"type": "integer"},
                    "client_ip": {"type": "ip"},
                    "server_ip": {"type": "ip"},
                    "tls_version": {"type": "keyword"},
                    "intercepted": {"type": "boolean"},
                    "modified": {"type": "boolean"}
                }
            },
            "settings": {
                "number_of_shards": 1,
                "number_of_replicas": 0,
                "refresh_interval": "1s"
            }
        }
        
        await self.client.indices.create(
            index=self.index_name,
            body=mapping
        )
        print(f"Created Elasticsearch index: {self.index_name}")

    async def store_request(self, request: HttpRequest):
        """Store HTTP request in Elasticsearch"""
        try:
            doc = request.dict()
            # Convert datetime to ISO string
            doc['timestamp'] = request.timestamp.isoformat()
            
            await self.client.index(
                index=self.index_name,
                id=request.id,
                body=doc
            )
            
        except Exception as e:
            print(f"Error storing request {request.id}: {e}")
            raise

    async def update_request(self, request_id: str, request: HttpRequest):
        """Update existing request with response data"""
        try:
            doc = request.dict()
            doc['timestamp'] = request.timestamp.isoformat()
            
            await self.client.update(
                index=self.index_name,
                id=request_id,
                body={"doc": doc}
            )
            
        except NotFoundError:
            # If request doesn't exist, create it
            await self.store_request(request)
        except Exception as e:
            print(f"Error updating request {request_id}: {e}")
            raise

    async def get_request(self, request_id: str) -> Optional[HttpRequest]:
        """Get specific request by ID"""
        try:
            response = await self.client.get(
                index=self.index_name,
                id=request_id
            )
            
            doc = response['_source']
            # Convert timestamp back to datetime
            doc['timestamp'] = datetime.fromisoformat(doc['timestamp'])
            
            return HttpRequest(**doc)
            
        except NotFoundError:
            return None
        except Exception as e:
            print(f"Error getting request {request_id}: {e}")
            raise

    async def search_requests(
        self,
        limit: int = 100,
        offset: int = 0,
        method: Optional[str] = None,
        status_code: Optional[int] = None,
        host: Optional[str] = None,
        search: Optional[str] = None,
        date_from: Optional[datetime] = None,
        date_to: Optional[datetime] = None
    ) -> List[HttpRequest]:
        """Search requests with filters"""
        try:
            # Build query
            query = {"bool": {"must": []}}
            
            if method:
                query["bool"]["must"].append({"term": {"method": method}})
                
            if status_code:
                query["bool"]["must"].append({"term": {"status_code": status_code}})
                
            if host:
                query["bool"]["must"].append({"term": {"host": host}})
                
            if search:
                query["bool"]["must"].append({
                    "multi_match": {
                        "query": search,
                        "fields": ["url", "host", "path", "body", "response_body"]
                    }
                })
                
            # Date range filter
            if date_from or date_to:
                date_range = {}
                if date_from:
                    date_range["gte"] = date_from.isoformat()
                if date_to:
                    date_range["lte"] = date_to.isoformat()
                    
                query["bool"]["must"].append({
                    "range": {"timestamp": date_range}
                })
            
            # If no filters, match all
            if not query["bool"]["must"]:
                query = {"match_all": {}}
            
            # Execute search
            response = await self.client.search(
                index=self.index_name,
                body={
                    "query": query,
                    "sort": [{"timestamp": {"order": "desc"}}],
                    "from": offset,
                    "size": limit
                }
            )
            
            requests = []
            for hit in response['hits']['hits']:
                doc = hit['_source']
                doc['timestamp'] = datetime.fromisoformat(doc['timestamp'])
                requests.append(HttpRequest(**doc))
                
            return requests
            
        except Exception as e:
            print(f"Error searching requests: {e}")
            raise

    async def get_stats(self) -> Dict[str, Any]:
        """Get request statistics"""
        try:
            # Get total count
            total_response = await self.client.count(index=self.index_name)
            total_requests = total_response['count']
            
            # Get status code distribution
            status_agg = await self.client.search(
                index=self.index_name,
                body={
                    "size": 0,
                    "aggs": {
                        "status_codes": {
                            "terms": {"field": "status_code", "size": 10}
                        }
                    }
                }
            )
            
            # Get method distribution
            method_agg = await self.client.search(
                index=self.index_name,
                body={
                    "size": 0,
                    "aggs": {
                        "methods": {
                            "terms": {"field": "method", "size": 10}
                        }
                    }
                }
            )
            
            # Get average response time
            response_time_agg = await self.client.search(
                index=self.index_name,
                body={
                    "size": 0,
                    "aggs": {
                        "avg_response_time": {
                            "avg": {"field": "response_time"}
                        }
                    }
                }
            )
            
            # Get requests from last 24 hours
            yesterday = datetime.utcnow() - timedelta(days=1)
            recent_response = await self.client.count(
                index=self.index_name,
                body={
                    "query": {
                        "range": {
                            "timestamp": {"gte": yesterday.isoformat()}
                        }
                    }
                }
            )
            
            status_codes = {}
            for bucket in status_agg['aggregations']['status_codes']['buckets']:
                status_codes[bucket['key']] = bucket['doc_count']
                
            methods = {}
            for bucket in method_agg['aggregations']['methods']['buckets']:
                methods[bucket['key']] = bucket['doc_count']
            
            avg_response_time = response_time_agg['aggregations']['avg_response_time']['value']
            
            return {
                "total_requests": total_requests,
                "requests_24h": recent_response['count'],
                "status_codes": status_codes,
                "methods": methods,
                "avg_response_time": avg_response_time or 0,
                "success_rate": status_codes.get(200, 0) / total_requests * 100 if total_requests > 0 else 0
            }
            
        except Exception as e:
            print(f"Error getting stats: {e}")
            raise

    async def health_check(self) -> Dict[str, Any]:
        """Check Elasticsearch health"""
        try:
            if not self.client:
                return {"status": "disconnected"}
                
            cluster_health = await self.client.cluster.health()
            index_exists = await self.client.indices.exists(index=self.index_name)
            
            return {
                "status": "healthy",
                "cluster_status": cluster_health['status'],
                "index_exists": index_exists,
                "connection": "ok"
            }
            
        except Exception as e:
            return {
                "status": "unhealthy",
                "error": str(e),
                "connection": "failed"
            }

    async def delete_request(self, request_id: str):
        """Delete a specific request"""
        try:
            await self.client.delete(
                index=self.index_name,
                id=request_id
            )
        except NotFoundError:
            pass  # Already deleted
        except Exception as e:
            print(f"Error deleting request {request_id}: {e}")
            raise

    async def clear_all_requests(self):
        """Clear all requests from the index"""
        try:
            await self.client.delete_by_query(
                index=self.index_name,
                body={"query": {"match_all": {}}}
            )
        except Exception as e:
            print(f"Error clearing requests: {e}")
            raise

    async def close(self):
        """Close Elasticsearch connection"""
        if self.client:
            await self.client.close()