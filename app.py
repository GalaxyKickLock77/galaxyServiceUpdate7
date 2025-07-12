from flask import Flask, request, jsonify
import subprocess
import json
import os
import threading
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask_cors import CORS
import signal
import time
from flask_socketio import SocketIO, emit
import asyncio
from threading import Lock

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Configuration
GALAXY_BACKEND_PATH = "/galaxybackend"
MAX_WORKERS = 8
TIMEOUT_SECONDS = 3

# Thread pool and locks
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
galaxy_processes = {i: None for i in range(1, 6)}
process_lock = threading.RLock()

# Ultra-fast caching
config_cache = {}
status_cache = {"time": 0, "data": {}}

# WebSocket connections tracking
active_connections = {}
connection_lock = Lock()
response_cache = {}

def string_to_bool(value):
    """Lightning-fast boolean conversion"""
    return isinstance(value, str) and value.lower().strip() in ('true', '1', 'yes', 'on') if isinstance(value, str) else bool(value)

def write_config_instant(data, form_number):
    """Instant config writing with atomic file replacement"""
    config = {
        "RC1": data[f'RC1{form_number}'],
        "RC2": data[f'RC2{form_number}'],
        "RC1_startAttackTime": int(data[f'RC1_startAttackTime{form_number}']),
        "RC1_stopAttackTime": int(data[f'RC1_stopAttackTime{form_number}']),
        "RC1_attackIntervalTime": int(data[f'RC1_attackIntervalTime{form_number}']),
        "RC1_startDefenceTime": int(data[f'RC1_startDefenceTime{form_number}']),
        "RC1_stopDefenceTime": int(data[f'RC1_stopDefenceTime{form_number}']),
        "RC1_defenceIntervalTime": int(data[f'RC1_defenceIntervalTime{form_number}']),
        "planetName": data[f'PlanetName{form_number}'],
        "blackListRival": data[f'blackListRival{form_number}'].split(',') if isinstance(data[f'blackListRival{form_number}'], str) else data[f'blackListRival{form_number}'],
        "whiteListMember": data[f'whiteListMember{form_number}'].split(',') if isinstance(data[f'whiteListMember{form_number}'], str) else data[f'whiteListMember{form_number}'],
        "kickAllToggle": string_to_bool(data[f'kickAllToggle{form_number}']),
        "standOnEnemy": string_to_bool(data[f'standOnEnemy{form_number}']),
        "actionOnEnemy": string_to_bool(data[f'actionOnEnemy{form_number}']),
        "aiChatToggle": string_to_bool(data[f'aiChatToggle{form_number}']),
        "dualRCToggle": string_to_bool(data[f'dualRCToggle{form_number}']),
        "aiPilotToggle": string_to_bool(data[f'aiPilotToggle{form_number}'])
    }

    if config['dualRCToggle']:
        config["RC2_startAttackTime"] = int(data[f'RC2_startAttackTime{form_number}'])
        config["RC2_stopAttackTime"] = int(data[f'RC2_stopAttackTime{form_number}'])
        config["RC2_attackIntervalTime"] = int(data[f'RC2_attackIntervalTime{form_number}'])
        config["RC2_startDefenceTime"] = int(data[f'RC2_startDefenceTime{form_number}'])
        config["RC2_stopDefenceTime"] = int(data[f'RC2_stopDefenceTime{form_number}'])
        config["RC2_defenceIntervalTime"] = int(data[f'RC2_defenceIntervalTime{form_number}'])

    # Add timestamp to force file change detection
    config["lastUpdated"] = int(time.time() * 1000)
    
    config_cache[form_number] = config
    
    # Async file write with atomic replacement
    def write_bg():
        try:
            config_path = os.path.join(GALAXY_BACKEND_PATH, f'config{form_number}.json')
            
            # First, ensure the file exists and is readable
            if os.path.exists(config_path):
                try:
                    with open(config_path, 'r') as test_read:
                        test_read.read(1)  # Just read 1 byte to test access
                except Exception as e:
                    print(f"Warning: Config file {form_number} exists but can't be read: {e}")
            
            # Write to temp file and replace atomically
            with tempfile.NamedTemporaryFile('w', delete=False, dir=os.path.dirname(config_path)) as temp_file:
                json.dump(config, temp_file, separators=(',', ':'))
                temp_file.flush()
                os.fsync(temp_file.fileno())
            
            # Replace the file atomically
            os.replace(temp_file.name, config_path)
            
            # Force modification time update and sync to disk
            current_time = time.time()
            os.utime(config_path, (current_time, current_time))
            
            # Notify PM2 about the config change (optional)
            try:
                subprocess.run(['pm2', 'sendSignal', 'SIGUSR2', f'galaxy_{form_number}'], 
                              timeout=1, capture_output=True)
            except Exception as e:
                # This is optional, so just log errors
                print(f"PM2 signal send error (non-critical): {e}")
                
            print(f"Config {form_number} updated successfully at {time.strftime('%H:%M:%S')}")
        except Exception as e:
            print(f"Config write error {form_number}: {e}")
    
    executor.submit(write_bg)
    return config

def nuclear_kill(form_number):
    """Nuclear option - kill everything related to this form"""
    killed_pids = []
    
    try:
        # 1. PM2 force delete
        subprocess.run(['pm2', 'delete', f'galaxy_{form_number}', '--force'], 
                      cwd=GALAXY_BACKEND_PATH, timeout=1, capture_output=True)
        
        # 2. Pattern-based killing
        try:
            result = subprocess.run(['pgrep', '-f', f'galaxy_{form_number}'], 
                                  capture_output=True, text=True, timeout=1)
            if result.stdout.strip():
                pids = [int(p) for p in result.stdout.strip().split('\n') if p.strip().isdigit()]
                for pid in pids:
                    try:
                        os.kill(pid, signal.SIGKILL)
                        killed_pids.append(pid)
                    except:
                        pass
        except:
            pass
        
        # 3. ps-based hunting
        try:
            result = subprocess.run(['ps', 'aux'], capture_output=True, text=True, timeout=1)
            if result.returncode == 0:
                for line in result.stdout.split('\n'):
                    if f'galaxy_{form_number}' in line and ('node' in line or 'pm2' in line):
                        parts = line.split()
                        if len(parts) > 1 and parts[1].isdigit():
                            try:
                                pid = int(parts[1])
                                os.kill(pid, signal.SIGKILL)
                                killed_pids.append(pid)
                            except:
                                pass
        except:
            pass
        
        # 4. PM2 cleanup
        subprocess.run(['pm2', 'flush'], timeout=1, capture_output=True)
        
    except Exception as e:
        print(f"Nuclear kill error {form_number}: {e}")
    
    return killed_pids

@socketio.on('galaxy_connect')
def handle_galaxy_connect(data):
    """Handle galaxy_1.js WebSocket connection"""
    form_number = data.get('form_number', 1)
    with connection_lock:
        active_connections[form_number] = request.sid
    print(f"Galaxy_{form_number} connected via WebSocket: {request.sid}")
    emit('connection_confirmed', {'form_number': form_number, 'status': 'connected'})

@socketio.on('galaxy_response')
def handle_galaxy_response(data):
    """Handle responses from galaxy_1.js"""
    form_number = data.get('form_number')
    response_id = data.get('response_id')
    response_data = data.get('response')
    
    if response_id:
        response_cache[response_id] = {
            'data': response_data,
            'timestamp': time.time(),
            'form_number': form_number
        }
    print(f"Received response from Galaxy_{form_number}: {response_data}")

@socketio.on('disconnect')
def handle_disconnect():
    """Handle WebSocket disconnection"""
    with connection_lock:
        for form_num, sid in list(active_connections.items()):
            if sid == request.sid:
                del active_connections[form_num]
                print(f"Galaxy_{form_num} disconnected")
                break



@app.route('/start/<int:form_number>', methods=['POST'])
def start_galaxy(form_number):
    """Instant start response"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    try:
        data = request.json or {}
        write_config_instant(data, form_number)
        
        script_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
        if not os.path.exists(script_path):
            return jsonify({"error": f"Script missing: galaxy_{form_number}.js"}), 404
        
        def start_bg():
            try:
                with process_lock:
                    # Kill existing first
                    nuclear_kill(form_number)
                    
                    # Build command
                    cmd = ['pm2', 'start', script_path, '--name', f'galaxy_{form_number}', '--']
                    
                    # Add args efficiently
                    arg_map = {
                        'RC1': 'RC1', 'RC2': 'RC2', 'startAttackTime': 'startAttackTime',
                        'stopAttackTime': 'stopAttackTime', 'attackIntervalTime': 'attackIntervalTime',
                        'startDefenceTime': 'startDefenceTime', 'stopDefenceTime': 'stopDefenceTime',
                        'defenceIntervalTime': 'defenceIntervalTime', 'PlanetName': 'planetName',
                        'blackListRival': 'blackListRival', 'whiteListMember': 'whiteListMember',
                        'kickAllToggle': 'kickAllToggle', 'standOnEnemy': 'standOnEnemy',
                        'actionOnEnemy': 'actionOnEnemy', 'aiChatToggle': 'aiChatToggle',
                        'dualRCToggle': 'dualRCToggle'
                    }
                    
                    for key, val in data.items():
                        base_key = key.rstrip('12345')
                        if base_key in arg_map:
                            cmd.extend([f'--{arg_map[base_key]}', str(val)])
                    
                    # Start process
                    proc = subprocess.Popen(cmd, cwd=GALAXY_BACKEND_PATH, 
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    galaxy_processes[form_number] = proc
                    
            except Exception as e:
                print(f"Start error {form_number}: {e}")
        
        executor.submit(start_bg)
        
        return jsonify({
            "message": f"Galaxy_{form_number} launching...",
            "status": "starting",
            "form": form_number,
            "timestamp": int(time.time())
        }), 200
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/stop/<int:form_number>', methods=['POST'])
def stop_galaxy(form_number):
    """Instant nuclear stop"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    # Execute nuclear kill in background
    executor.submit(lambda: nuclear_kill(form_number))
    
    # Clear process reference immediately
    with process_lock:
        galaxy_processes[form_number] = None
    
    return jsonify({
        "message": f"Galaxy_{form_number} terminated!",
        "status": "killed",
        "form": form_number,
        "method": "nuclear",
        "timestamp": int(time.time())
    }), 200

@app.route('/update/<int:form_number>', methods=['POST'])
def update_galaxy(form_number):
    """WebSocket config update with file fallback"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    try:
        data = request.json or {}
        
        # Build config object
        config = {
            "RC1": data.get(f'RC1{form_number}', ''),
            "RC2": data.get(f'RC2{form_number}', ''),
            "RC1_startAttackTime": int(data.get(f'RC1_startAttackTime{form_number}', 1870)),
            "RC1_stopAttackTime": int(data.get(f'RC1_stopAttackTime{form_number}', 1900)),
            "RC1_attackIntervalTime": int(data.get(f'RC1_attackIntervalTime{form_number}', 5)),
            "RC1_startDefenceTime": int(data.get(f'RC1_startDefenceTime{form_number}', 1870)),
            "RC1_stopDefenceTime": int(data.get(f'RC1_stopDefenceTime{form_number}', 1900)),
            "RC1_defenceIntervalTime": int(data.get(f'RC1_defenceIntervalTime{form_number}', 5)),
            "planetName": data.get(f'PlanetName{form_number}', ''),
            "blackListRival": data.get(f'blackListRival{form_number}', []),
            "whiteListMember": data.get(f'whiteListMember{form_number}', []),
            "kickAllToggle": string_to_bool(data.get(f'kickAllToggle{form_number}', True)),
            "standOnEnemy": string_to_bool(data.get(f'standOnEnemy{form_number}', True)),
            "actionOnEnemy": string_to_bool(data.get(f'actionOnEnemy{form_number}', False)),
            "aiChatToggle": string_to_bool(data.get(f'aiChatToggle{form_number}', False)),
            "dualRCToggle": string_to_bool(data.get(f'dualRCToggle{form_number}', True)),
            "aiPilotToggle": string_to_bool(data.get(f'aiPilotToggle{form_number}', False)),
            "timestamp": int(time.time() * 1000)
        }
        
        if config['dualRCToggle']:
            config.update({
                "RC2_startAttackTime": int(data.get(f'RC2_startAttackTime{form_number}', 1875)),
                "RC2_stopAttackTime": int(data.get(f'RC2_stopAttackTime{form_number}', 1900)),
                "RC2_attackIntervalTime": int(data.get(f'RC2_attackIntervalTime{form_number}', 5)),
                "RC2_startDefenceTime": int(data.get(f'RC2_startDefenceTime{form_number}', 1850)),
                "RC2_stopDefenceTime": int(data.get(f'RC2_stopDefenceTime{form_number}', 1925)),
                "RC2_defenceIntervalTime": int(data.get(f'RC2_defenceIntervalTime{form_number}', 5))
            })
        
        # Try WebSocket first
        with connection_lock:
            if form_number in active_connections:
                response_id = f"config_{form_number}_{int(time.time() * 1000)}"
                
                socketio.emit('config_update', {
                    'config': config,
                    'response_id': response_id,
                    'form_number': form_number
                }, room=active_connections[form_number])
                
                # Wait for response
                start_time = time.time()
                while time.time() - start_time < 2:
                    if response_id in response_cache:
                        response = response_cache.pop(response_id)
                        return jsonify({
                            "message": f"Galaxy_{form_number} config updated via WebSocket",
                            "status": "updated",
                            "method": "websocket",
                            "form": form_number,
                            "response": response['data'],
                            "timestamp": int(time.time())
                        }), 200
                    time.sleep(0.01)
        
        # Fallback to file-based update
        config_file = write_config_instant(data, form_number)
        
        return jsonify({
            "message": f"Galaxy_{form_number} config updated via file (WebSocket unavailable)",
            "status": "updated",
            "method": "file",
            "form": form_number,
            "timestamp": int(time.time()),
            "config_keys": list(config_file.keys())
        }), 200
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/status', methods=['GET'])
def get_status():
    """Smart cached status"""
    now = time.time()
    
    # Return cached if recent (0.3 seconds)
    if now - status_cache["time"] < 0.3:
        return jsonify(status_cache["data"]), 200
    
    def get_pm2_status():
        try:
            result = subprocess.run(['pm2', 'jlist'], cwd=GALAXY_BACKEND_PATH,
                                  capture_output=True, text=True, timeout=2)
            if result.returncode == 0:
                return json.loads(result.stdout)
        except:
            pass
        return []
    
    pm2_data = get_pm2_status()
    pm2_map = {proc.get('name', '').replace('galaxy_', ''): proc 
               for proc in pm2_data if proc.get('name', '').startswith('galaxy_')}
    
    status = {}
    for form_num in range(1, 6):
        proc_info = pm2_map.get(str(form_num), {})
        is_online = proc_info.get('pm2_env', {}).get('status') == 'online'
        
        status[f"form_{form_num}"] = {
            "running": is_online,
            "pid": proc_info.get('pid'),
            "status": proc_info.get('pm2_env', {}).get('status', 'stopped'),
            "cpu": proc_info.get('monit', {}).get('cpu', 0),
            "memory": proc_info.get('monit', {}).get('memory', 0)
        }
    
    # Update cache
    status_cache["data"] = status
    status_cache["time"] = now
    
    return jsonify(status), 200

@app.route('/ping', methods=['GET'])
def ping():
    """Ultra-fast ping"""
    return jsonify({"pong": int(time.time() * 1000)}), 200

@app.route('/quick', methods=['GET'])
def quick_status():
    """Lightning-fast basic status"""
    status = {}
    try:
        with process_lock:
            for form_num in range(1, 6):
                proc = galaxy_processes[form_num]
                alive = proc is not None and proc.poll() is None
                status[f"form_{form_num}"] = {
                    "alive": alive,
                    "pid": proc.pid if alive else None
                }
    except:
        status = {f"form_{i}": {"alive": False, "pid": None} for i in range(1, 6)}
    
    return jsonify(status), 200

@app.route('/log/galaxy_1.log', methods=['GET'])
def stream_galaxy_1_log():
    """Streams the content of galaxy_1.log, including new lines as they are written."""
    log_file_path = os.path.join(GALAXY_BACKEND_PATH, 'galaxy_1.log')

    def generate():
        f = None
        last_position = 0
        retry_count = 0
        max_retries = 3
        
        while retry_count < max_retries:
            try:
                if not os.path.exists(log_file_path):
                    yield "Log file not found. Waiting...\n"
                    time.sleep(2)
                    continue
                    
                f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                f.seek(last_position)
                
                # Send existing content from last position
                content = f.read()
                if content:
                    yield content
                    last_position = f.tell()
                
                # Continuously stream new content
                while True:
                    try:
                        current_size = os.path.getsize(log_file_path)
                        if current_size < last_position:  # File was truncated
                            f.close()
                            f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                            yield "---FILE-TRUNCATED---\n"
                            content = f.read()
                            if content:
                                yield content
                            last_position = f.tell()
                        else:
                            new_content = f.read()
                            if new_content:
                                yield new_content
                                last_position = f.tell()
                        time.sleep(0.5)  # Faster polling
                    except (IOError, OSError) as e:
                        yield f"\n[Stream interrupted: {e}. Reconnecting...]\n"
                        break  # Break inner loop to retry
                        
            except Exception as e:
                retry_count += 1
                yield f"\n[Error: {e}. Retry {retry_count}/{max_retries}]\n"
                time.sleep(1)
            finally:
                if f:
                    try:
                        f.close()
                    except:
                        pass
                    f = None
        
        yield "\n[Max retries exceeded. Stream ended.]\n"

    return app.response_class(generate(), mimetype='text/plain')

@app.route('/log/galaxy_2.log', methods=['GET'])
def stream_galaxy_2_log():
    """Streams the content of galaxy_2.log, including new lines as they are written."""
    log_file_path = os.path.join(GALAXY_BACKEND_PATH, 'galaxy_2.log')

    def generate():
        f = None
        last_position = 0
        retry_count = 0
        max_retries = 3
        
        while retry_count < max_retries:
            try:
                if not os.path.exists(log_file_path):
                    yield "Log file not found. Waiting...\n"
                    time.sleep(2)
                    continue
                    
                f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                f.seek(last_position)
                
                # Send existing content from last position
                content = f.read()
                if content:
                    yield content
                    last_position = f.tell()
                
                # Continuously stream new content
                while True:
                    try:
                        current_size = os.path.getsize(log_file_path)
                        if current_size < last_position:  # File was truncated
                            f.close()
                            f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                            yield "---FILE-TRUNCATED---\n"
                            content = f.read()
                            if content:
                                yield content
                            last_position = f.tell()
                        else:
                            new_content = f.read()
                            if new_content:
                                yield new_content
                                last_position = f.tell()
                        time.sleep(0.5)  # Faster polling
                    except (IOError, OSError) as e:
                        yield f"\n[Stream interrupted: {e}. Reconnecting...]\n"
                        break  # Break inner loop to retry
                        
            except Exception as e:
                retry_count += 1
                yield f"\n[Error: {e}. Retry {retry_count}/{max_retries}]\n"
                time.sleep(1)
            finally:
                if f:
                    try:
                        f.close()
                    except:
                        pass
                    f = None
        
        yield "\n[Max retries exceeded. Stream ended.]\n"

    return app.response_class(generate(), mimetype='text/plain')

@app.route('/log/galaxy_3.log', methods=['GET'])
def stream_galaxy_3_log():
    """Streams the content of galaxy_3.log, including new lines as they are written."""
    log_file_path = os.path.join(GALAXY_BACKEND_PATH, 'galaxy_3.log')

    def generate():
        f = None
        last_position = 0
        retry_count = 0
        max_retries = 3
        
        while retry_count < max_retries:
            try:
                if not os.path.exists(log_file_path):
                    yield "Log file not found. Waiting...\n"
                    time.sleep(2)
                    continue
                    
                f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                f.seek(last_position)
                
                # Send existing content from last position
                content = f.read()
                if content:
                    yield content
                    last_position = f.tell()
                
                # Continuously stream new content
                while True:
                    try:
                        current_size = os.path.getsize(log_file_path)
                        if current_size < last_position:  # File was truncated
                            f.close()
                            f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                            yield "---FILE-TRUNCATED---\n"
                            content = f.read()
                            if content:
                                yield content
                            last_position = f.tell()
                        else:
                            new_content = f.read()
                            if new_content:
                                yield new_content
                                last_position = f.tell()
                        time.sleep(0.5)  # Faster polling
                    except (IOError, OSError) as e:
                        yield f"\n[Stream interrupted: {e}. Reconnecting...]\n"
                        break  # Break inner loop to retry
                        
            except Exception as e:
                retry_count += 1
                yield f"\n[Error: {e}. Retry {retry_count}/{max_retries}]\n"
                time.sleep(1)
            finally:
                if f:
                    try:
                        f.close()
                    except:
                        pass
                    f = None
        
        yield "\n[Max retries exceeded. Stream ended.]\n"

    return app.response_class(generate(), mimetype='text/plain')

@app.route('/log/galaxy_4.log', methods=['GET'])
def stream_galaxy_4_log():
    """Streams the content of galaxy_4.log, including new lines as they are written."""
    log_file_path = os.path.join(GALAXY_BACKEND_PATH, 'galaxy_4.log')

    def generate():
        f = None
        last_position = 0
        retry_count = 0
        max_retries = 3
        
        while retry_count < max_retries:
            try:
                if not os.path.exists(log_file_path):
                    yield "Log file not found. Waiting...\n"
                    time.sleep(2)
                    continue
                    
                f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                f.seek(last_position)
                
                # Send existing content from last position
                content = f.read()
                if content:
                    yield content
                    last_position = f.tell()
                
                # Continuously stream new content
                while True:
                    try:
                        current_size = os.path.getsize(log_file_path)
                        if current_size < last_position:  # File was truncated
                            f.close()
                            f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                            yield "---FILE-TRUNCATED---\n"
                            content = f.read()
                            if content:
                                yield content
                            last_position = f.tell()
                        else:
                            new_content = f.read()
                            if new_content:
                                yield new_content
                                last_position = f.tell()
                        time.sleep(0.5)  # Faster polling
                    except (IOError, OSError) as e:
                        yield f"\n[Stream interrupted: {e}. Reconnecting...]\n"
                        break  # Break inner loop to retry
                        
            except Exception as e:
                retry_count += 1
                yield f"\n[Error: {e}. Retry {retry_count}/{max_retries}]\n"
                time.sleep(1)
            finally:
                if f:
                    try:
                        f.close()
                    except:
                        pass
                    f = None
        
        yield "\n[Max retries exceeded. Stream ended.]\n"

    return app.response_class(generate(), mimetype='text/plain')

@app.route('/log/galaxy_5.log', methods=['GET'])
def stream_galaxy_5_log():
    """Streams the content of galaxy_5.log, including new lines as they are written."""
    log_file_path = os.path.join(GALAXY_BACKEND_PATH, 'galaxy_5.log')

    def generate():
        f = None
        last_position = 0
        retry_count = 0
        max_retries = 3
        
        while retry_count < max_retries:
            try:
                if not os.path.exists(log_file_path):
                    yield "Log file not found. Waiting...\n"
                    time.sleep(2)
                    continue
                    
                f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                f.seek(last_position)
                
                # Send existing content from last position
                content = f.read()
                if content:
                    yield content
                    last_position = f.tell()
                
                # Continuously stream new content
                while True:
                    try:
                        current_size = os.path.getsize(log_file_path)
                        if current_size < last_position:  # File was truncated
                            f.close()
                            f = open(log_file_path, 'r', encoding='utf-8', errors='ignore')
                            yield "---FILE-TRUNCATED---\n"
                            content = f.read()
                            if content:
                                yield content
                            last_position = f.tell()
                        else:
                            new_content = f.read()
                            if new_content:
                                yield new_content
                                last_position = f.tell()
                        time.sleep(0.5)  # Faster polling
                    except (IOError, OSError) as e:
                        yield f"\n[Stream interrupted: {e}. Reconnecting...]\n"
                        break  # Break inner loop to retry
                        
            except Exception as e:
                retry_count += 1
                yield f"\n[Error: {e}. Retry {retry_count}/{max_retries}]\n"
                time.sleep(1)
            finally:
                if f:
                    try:
                        f.close()
                    except:
                        pass
                    f = None
        
        yield "\n[Max retries exceeded. Stream ended.]\n"

    return app.response_class(generate(), mimetype='text/plain')

def cleanup_on_exit():
    """Fast exit cleanup"""
    print("🧹 Fast cleanup...")
    futures = [executor.submit(nuclear_kill, i) for i in range(1, 6)]
    for f in futures:
        try:
            f.result(timeout=1)
        except:
            pass
    executor.shutdown(wait=False)

if __name__ == '__main__':
    signal.signal(signal.SIGINT, lambda s, f: (cleanup_on_exit(), exit(0)))
    signal.signal(signal.SIGTERM, lambda s, f: (cleanup_on_exit(), exit(0)))
    
    if not os.path.exists(GALAXY_BACKEND_PATH):
        print(f"❌ Backend path not found: {GALAXY_BACKEND_PATH}")
        exit(1)
    
    print("🚀 ULTRA-FAST Galaxy API with WebSocket")
    print(f"📁 Path: {GALAXY_BACKEND_PATH}")
    print("⚡ Zero-delay responses + Real-time WebSocket enabled!")
    print("🔌 WebSocket endpoint: ws://localhost:7860/socket.io/")
    
    socketio.run(app, host='0.0.0.0', port=7860, debug=False, allow_unsafe_werkzeug=True)
