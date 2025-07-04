#!/usr/bin/env python3
"""
Server di debug per verificare le richieste di Stremio agli endpoints TV
"""

import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
import time
from typing import Dict, Any

class DebugRequestHandler(BaseHTTPRequestHandler):
    
    def log_request_details(self, method: str):
        """Log dettagliato di ogni richiesta"""
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        print(f"\n🌐 [{timestamp}] INCOMING {method} REQUEST:")
        print(f"   URL: {self.path}")
        print(f"   Headers: {dict(self.headers)}")
        print(f"   Client: {self.client_address}")
        print(f"   User-Agent: {self.headers.get('User-Agent', 'N/A')}")
        print(f"────────────────────────────────────────────────────────────")
    
    def send_json_response(self, data: Dict[str, Any], status_code: int = 200):
        """Invia una risposta JSON"""
        response_json = json.dumps(data, indent=2)
        timestamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())
        
        print(f"📤 [{timestamp}] RESPONSE:")
        print(f"   Status: {status_code}")
        print(f"   Body: {response_json[:500]}{'...' if len(response_json) > 500 else ''}")
        print(f"════════════════════════════════════════════════════════════\n")
        
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(response_json.encode('utf-8'))
    
    def load_tv_channels(self):
        """Carica i canali TV"""
        try:
            with open('config/tv_channels.json', 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"❌ Error loading TV channels: {e}")
            return []
    
    def get_manifest(self, config_str: str = ""):
        """Genera il manifest dell'addon"""
        return {
            "id": f"org.streamvix.debug{f'.{config_str}' if config_str else ''}",
            "name": "StreamViX TV Debug",
            "description": "Debug addon for TV channels",
            "version": "1.0.0",
            "catalogs": [
                {
                    "type": "tv",
                    "id": "tv_channels",
                    "name": "TV Channels (Debug)"
                }
            ],
            "resources": ["catalog", "meta", "stream"],
            "types": ["tv"],
            "idPrefixes": ["tv:"]
        }
    
    def get_catalog(self, type_param: str, id_param: str):
        """Genera il catalogo TV"""
        if type_param == "tv" and id_param == "tv_channels":
            tv_channels = self.load_tv_channels()
            metas = []
            
            for channel in tv_channels:
                meta = {
                    "id": f"tv:{channel['id']}",
                    "type": "tv",
                    "name": channel["name"],
                    "poster": channel.get("logo", "https://via.placeholder.com/300x450/0066cc/ffffff?text=TV"),
                    "description": f"Live TV channel: {channel['name']}",
                    "genres": ["Live TV"]
                }
                metas.append(meta)
            
            return {"metas": metas}
        
        return {"metas": []}
    
    def get_meta(self, type_param: str, id_param: str):
        """Genera metadata per un canale specifico"""
        print(f"🔍 META REQUEST: type={type_param}, id={id_param}")
        
        if type_param == "tv" and id_param.startswith("tv:"):
            channel_id = id_param.replace("tv:", "")
            tv_channels = self.load_tv_channels()
            
            channel = next((c for c in tv_channels if c["id"] == channel_id), None)
            if channel:
                meta = {
                    "id": id_param,
                    "type": "tv",
                    "name": channel["name"],
                    "poster": channel.get("logo", "https://via.placeholder.com/300x450/0066cc/ffffff?text=TV"),
                    "description": f"Live TV channel: {channel['name']}",
                    "genres": ["Live TV"],
                    "runtime": "Live",
                    "year": 2024
                }
                return {"meta": meta}
        
        print(f"❌ No meta found for {type_param}:{id_param}")
        return {"meta": None}
    
    def get_streams(self, type_param: str, id_param: str):
        """Genera stream per un canale specifico"""
        print(f"🎬 STREAM REQUEST: type={type_param}, id={id_param}")
        
        if type_param == "tv" and id_param.startswith("tv:"):
            channel_id = id_param.replace("tv:", "")
            tv_channels = self.load_tv_channels()
            
            channel = next((c for c in tv_channels if c["id"] == channel_id), None)
            if channel:
                streams = []
                
                # Stream principale
                if channel.get("staticUrl"):
                    stream = {
                        "url": channel["staticUrl"],
                        "title": f"📺 {channel['name']} (Direct)",
                        "description": "Direct stream URL"
                    }
                    streams.append(stream)
                
                # Stream di backup se disponibile
                if channel.get("vavooNames"):
                    backup_stream = {
                        "url": f"https://example.com/backup/{channel_id}.m3u8",
                        "title": f"📺 {channel['name']} (Backup)",
                        "description": "Backup stream via Vavoo"
                    }
                    streams.append(backup_stream)
                
                print(f"✅ Returning {len(streams)} streams for {channel['name']}")
                return {"streams": streams}
        
        print(f"❌ No streams found for {type_param}:{id_param}")
        return {"streams": []}
    
    def do_GET(self):
        """Gestisce le richieste GET"""
        self.log_request_details("GET")
        
        # Parse URL
        parsed_url = urlparse(self.path)
        path_parts = [p for p in parsed_url.path.split('/') if p]
        
        try:
            # Manifest
            if len(path_parts) == 1 and path_parts[0] == "manifest.json":
                response = self.get_manifest()
                self.send_json_response(response)
                return
            
            # Manifest con config
            if len(path_parts) == 2 and path_parts[1] == "manifest.json":
                config_str = path_parts[0]
                response = self.get_manifest(config_str)
                self.send_json_response(response)
                return
            
            # Catalog
            if "catalog" in path_parts:
                catalog_idx = path_parts.index("catalog")
                if len(path_parts) > catalog_idx + 2:
                    type_param = path_parts[catalog_idx + 1]
                    id_param = path_parts[catalog_idx + 2].replace(".json", "")
                    response = self.get_catalog(type_param, id_param)
                    self.send_json_response(response)
                    return
            
            # Meta
            if "meta" in path_parts:
                meta_idx = path_parts.index("meta")
                if len(path_parts) > meta_idx + 2:
                    type_param = path_parts[meta_idx + 1]
                    id_param = path_parts[meta_idx + 2].replace(".json", "")
                    response = self.get_meta(type_param, id_param)
                    self.send_json_response(response)
                    return
            
            # Stream  
            if "stream" in path_parts:
                stream_idx = path_parts.index("stream")
                if len(path_parts) > stream_idx + 2:
                    type_param = path_parts[stream_idx + 1]
                    id_param = path_parts[stream_idx + 2].replace(".json", "")
                    response = self.get_streams(type_param, id_param)
                    self.send_json_response(response)
                    return
            
            # 404 per tutti gli altri path
            print(f"❌ Unknown path: {self.path}")
            self.send_json_response({"error": "Not found"}, 404)
            
        except Exception as e:
            print(f"❌ Error handling request: {e}")
            self.send_json_response({"error": str(e)}, 500)
    
    def do_OPTIONS(self):
        """Gestisce le richieste OPTIONS (CORS preflight)"""
        self.log_request_details("OPTIONS")
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()

def main():
    print("🚀 Starting StreamViX TV Debug Server...")
    print("📺 Loading TV channels...")
    
    # Verifica che i file esistano
    if not os.path.exists('config/tv_channels.json'):
        print("❌ config/tv_channels.json not found!")
        return
    
    # Carica e mostra i canali
    try:
        with open('config/tv_channels.json', 'r', encoding='utf-8') as f:
            tv_channels = json.load(f)
        print(f"✅ Loaded {len(tv_channels)} TV channels:")
        for channel in tv_channels:
            print(f"   - {channel['name']} (id: {channel['id']})")
    except Exception as e:
        print(f"❌ Error loading channels: {e}")
        return
    
    # Avvia il server
    port = 8080
    server = HTTPServer(('0.0.0.0', port), DebugRequestHandler)
    print(f"\n🌐 Server running on http://localhost:{port}")
    print(f"📱 Add this URL in Stremio: http://localhost:{port}/manifest.json")
    print(f"🔍 All requests will be logged in detail!")
    print(f"\n📋 Available endpoints:")
    print(f"   - Manifest: http://localhost:{port}/manifest.json")
    print(f"   - Catalog:  http://localhost:{port}/catalog/tv/tv_channels.json")
    print(f"   - Meta:     http://localhost:{port}/meta/tv/tv:CHANNEL_ID.json")
    print(f"   - Stream:   http://localhost:{port}/stream/tv/tv:CHANNEL_ID.json")
    print(f"\n🛑 Press Ctrl+C to stop the server")
    print("=" * 60)
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n🛑 Server stopped")

if __name__ == "__main__":
    main()
