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

app = Flask(__name__)
CORS(app)

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
        "RC2_startAttackTime": int(data[f'RC2_startAttackTime{form_number}']),
        "RC2_stopAttackTime": int(data[f'RC2_stopAttackTime{form_number}']),
        "RC2_attackIntervalTime": int(data[f'RC2_attackIntervalTime{form_number}']),
        "RC2_startDefenceTime": int(data[f'RC2_startDefenceTime{form_number}']),
        "RC2_stopDefenceTime": int(data[f'RC2_stopDefenceTime{form_number}']),
        "RC2_defenceIntervalTime": int(data[f'RC2_defenceIntervalTime{form_number}']),
        "planetName": data[f'PlanetName{form_number}'],
        "rival": data[f'Rival{form_number}'].split(',') if isinstance(data[f'Rival{form_number}'], str) else data[f'Rival{form_number}'],
        "standOnEnemy": string_to_bool(data[f'standOnEnemy{form_number}']),
        "actionOnEnemy": string_to_bool(data[f'actionOnEnemy{form_number}']),
        "aiChatToggle": string_to_bool(data[f'aiChatToggle{form_number}'])
    }
    
    config_cache[form_number] = config
    
    # Async file write with atomic replacement
    def write_bg():
        try:
            config_path = os.path.join(GALAXY_BACKEND_PATH, f'config{form_number}.json')
            with tempfile.NamedTemporaryFile('w', delete=False, dir=os.path.dirname(config_path)) as temp_file:
                json.dump(config, temp_file, separators=(',', ':'))
                temp_file.flush()
                os.fsync(temp_file.fileno())
            os.replace(temp_file.name, config_path)
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
                        'Rival': 'rival', 'standOnEnemy': 'standOnEnemy', 'actionOnEnemy': 'actionOnEnemy',
                        'aiChatToggle': 'aiChatToggle'
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
    """Instant config update"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    try:
        data = request.json or {}
        write_config_instant(data, form_number)
        
        return jsonify({
            "message": f"Galaxy_{form_number} config updated",
            "status": "updated",
            "form": form_number,
            "timestamp": int(time.time())
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
    
    print("🚀 ULTRA-FAST Galaxy API")
    print(f"📁 Path: {GALAXY_BACKEND_PATH}")
    print("⚡ Zero-delay responses enabled!")
    
    app.run(host='0.0.0.0', port=7860, debug=False, threaded=True)