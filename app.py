from flask import Flask, request, jsonify
import subprocess
import json
import os
import threading
import asyncio
from concurrent.futures import ThreadPoolExecutor
from flask_cors import CORS
import signal
import psutil
import time

app = Flask(__name__)
CORS(app)

# Configuration
GALAXY_BACKEND_PATH = "/galaxybackend"
MAX_WORKERS = 10  # Thread pool size for async operations
TIMEOUT_SECONDS = 5  # Maximum timeout for operations

# Thread pool for async operations
executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

# Global state management with thread-safe operations
galaxy_processes = {i: None for i in range(1, 6)}
process_lock = threading.RLock()

# Cache for frequently accessed data
config_cache = {}
status_cache = {"last_update": 0, "data": {}}

def string_to_bool(value):
    """Ultra-fast boolean conversion"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.lower().strip() in ('true', '1', 'yes', 'on')
    return bool(value)

def write_config_fast(data, form_number):
    """Optimized config writing with minimal I/O"""
    config = {
        "RC1": data[f'RC1{form_number}'],
        "RC2": data[f'RC2{form_number}'],
        "startAttackTime": int(data[f'startAttackTime{form_number}']),
        "stopAttackTime": int(data[f'stopAttackTime{form_number}']),
        "attackIntervalTime": int(data[f'attackIntervalTime{form_number}']),
        "startDefenceTime": int(data[f'startDefenceTime{form_number}']),
        "stopDefenceTime": int(data[f'stopDefenceTime{form_number}']),
        "defenceIntervalTime": int(data[f'defenceIntervalTime{form_number}']),
        "planetName": data[f'PlanetName{form_number}'],
        "rival": data[f'Rival{form_number}'].split(',') if isinstance(data[f'Rival{form_number}'], str) else data[f'Rival{form_number}'],
        "standOnEnemy": string_to_bool(data[f'standOnEnemy{form_number}']),
        "actionOnEnemy": string_to_bool(data[f'actionOnEnemy{form_number}'])
    }
    
    # Cache the config for quick access
    config_cache[form_number] = config
    
    # Write to file asynchronously
    config_path = os.path.join(GALAXY_BACKEND_PATH, f'config{form_number}.json')
    
    def write_file():
        try:
            with open(config_path, 'w') as f:
                json.dump(config, f, separators=(',', ':'))  # Compact JSON
        except Exception as e:
            print(f"Config write error for form {form_number}: {e}")
    
    # Execute file write in background thread
    executor.submit(write_file)
    return config

def force_kill_pm2_process(form_number):
    """Forcefully kill PM2 process with multiple methods"""
    killed_pids = []
    
    try:
        # Method 1: PM2 delete with force
        result = subprocess.run(
            ['pm2', 'delete', f'galaxy_{form_number}', '--force'],
            cwd=GALAXY_BACKEND_PATH,
            capture_output=True,
            text=True,
            timeout=2
        )
        
        # Method 2: Find and kill by name pattern
        try:
            ps_result = subprocess.run(
                ['pgrep', '-f', f'galaxy_{form_number}.js'],
                capture_output=True,
                text=True,
                timeout=1
            )
            
            if ps_result.stdout.strip():
                pids = ps_result.stdout.strip().split('\n')
                for pid in pids:
                    try:
                        os.kill(int(pid), signal.SIGKILL)
                        killed_pids.append(int(pid))
                    except:
                        pass
        except:
            pass
        
        # Method 3: Use psutil for process hunting
        try:
            for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
                try:
                    if proc.info['cmdline'] and any(f'galaxy_{form_number}' in arg for arg in proc.info['cmdline']):
                        proc.kill()
                        killed_pids.append(proc.info['pid'])
                except:
                    pass
        except:
            pass
            
    except Exception as e:
        print(f"Force kill error for form {form_number}: {e}")
    
    return killed_pids

@app.route('/start/<int:form_number>', methods=['POST'])
def start_galaxy(form_number):
    """Ultra-fast galaxy start with immediate response"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    try:
        data = request.json
        if not data:
            return jsonify({"error": "No data provided"}), 400
        
        # Write config asynchronously (non-blocking)
        config = write_config_fast(data, form_number)
        
        galaxy_script_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
        
        # Quick file existence check
        if not os.path.exists(galaxy_script_path):
            return jsonify({"error": f"Script not found: galaxy_{form_number}.js"}), 404
        
        def start_process():
            try:
                with process_lock:
                    # Force stop existing process first
                    if galaxy_processes[form_number]:
                        force_kill_pm2_process(form_number)
                    
                    # Build command quickly
                    cmd = ['pm2', 'start', galaxy_script_path, '--name', f'galaxy_{form_number}', '--']
                    
                    # Add arguments efficiently
                    arg_map = {
                        'RC1': 'RC1', 'RC2': 'RC2',
                        'startAttackTime': 'startAttackTime', 'stopAttackTime': 'stopAttackTime',
                        'attackIntervalTime': 'attackIntervalTime',
                        'startDefenceTime': 'startDefenceTime', 'stopDefenceTime': 'stopDefenceTime',
                        'defenceIntervalTime': 'defenceIntervalTime',
                        'PlanetName': 'planetName', 'Rival': 'rival',
                        'standOnEnemy': 'standOnEnemy', 'actionOnEnemy': 'actionOnEnemy'
                    }
                    
                    for key, value in data.items():
                        base_key = key.rstrip('12345')
                        if base_key in arg_map:
                            cmd.extend([f'--{arg_map[base_key]}', str(value)])
                    
                    # Start process with timeout
                    process = subprocess.Popen(
                        cmd,
                        cwd=GALAXY_BACKEND_PATH,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )
                    
                    galaxy_processes[form_number] = process
                    
            except Exception as e:
                print(f"Start process error for form {form_number}: {e}")
        
        # Start process in background thread
        executor.submit(start_process)
        
        # Return immediate response
        return jsonify({
            "message": f"Galaxy_{form_number} starting...",
            "status": "initiated",
            "form_number": form_number
        }), 200
        
    except Exception as e:
        return jsonify({"error": f"Start failed: {str(e)}"}), 500

@app.route('/stop/<int:form_number>', methods=['POST'])
def stop_galaxy(form_number):
    """Ultra-fast forceful stop with immediate response"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    def force_stop():
        killed_pids = []
        try:
            with process_lock:
                # Get current PID if available
                current_pid = None
                if galaxy_processes[form_number]:
                    try:
                        current_pid = galaxy_processes[form_number].pid
                    except:
                        pass
                
                # Force kill using multiple methods
                killed_pids = force_kill_pm2_process(form_number)
                
                # Additional cleanup
                try:
                    subprocess.run(['pm2', 'flush'], timeout=1, capture_output=True)
                    subprocess.run(['pm2', 'reload'], timeout=1, capture_output=True)
                except:
                    pass
                
                # Clear process reference
                galaxy_processes[form_number] = None
                
                if current_pid and current_pid not in killed_pids:
                    killed_pids.append(current_pid)
                    
        except Exception as e:
            print(f"Force stop error for form {form_number}: {e}")
        
        return killed_pids
    
    # Execute stop in background
    executor.submit(force_stop)
    
    # Return immediate response
    return jsonify({
        "message": f"Galaxy_{form_number} force stopping...",
        "status": "terminating",
        "form_number": form_number
    }), 200

@app.route('/update/<int:form_number>', methods=['POST'])
def update_galaxy(form_number):
    """Ultra-fast config update with immediate response"""
    if form_number not in range(1, 6):
        return jsonify({"error": "Invalid form number"}), 400
    
    try:
        data = request.json
        if not data:
            return jsonify({"error": "No data provided"}), 400
        
        # Update config asynchronously
        write_config_fast(data, form_number)
        
        # Return immediate response
        return jsonify({
            "message": f"Galaxy_{form_number} config updating...",
            "status": "updated",
            "form_number": form_number
        }), 200
        
    except Exception as e:
        return jsonify({"error": f"Update failed: {str(e)}"}), 500

@app.route('/status', methods=['GET'])
def get_status():
    """Ultra-fast status check with caching"""
    current_time = time.time()
    
    # Use cached status if recent (within 0.5 seconds)
    if current_time - status_cache["last_update"] < 0.5:
        return jsonify(status_cache["data"]), 200
    
    def get_real_status():
        status = {}
        try:
            # Quick PM2 list check
            result = subprocess.run(
                ['pm2', 'jlist'],
                cwd=GALAXY_BACKEND_PATH,
                capture_output=True,
                text=True,
                timeout=2
            )
            
            pm2_processes = {}
            if result.returncode == 0:
                try:
                    pm2_data = json.loads(result.stdout)
                    for proc in pm2_data:
                        if proc.get('name', '').startswith('galaxy_'):
                            form_num = int(proc['name'].split('_')[1])
                            pm2_processes[form_num] = {
                                'status': proc.get('pm2_env', {}).get('status', 'unknown'),
                                'pid': proc.get('pid'),
                                'cpu': proc.get('monit', {}).get('cpu', 0),
                                'memory': proc.get('monit', {}).get('memory', 0)
                            }
                except:
                    pass
            
            for form_number in range(1, 6):
                pm2_info = pm2_processes.get(form_number, {})
                is_running = pm2_info.get('status') == 'online'
                
                status[f"form_{form_number}"] = {
                    "galaxy_running": is_running,
                    "galaxy_pid": pm2_info.get('pid'),
                    "status": pm2_info.get('status', 'stopped'),
                    "cpu_usage": pm2_info.get('cpu', 0),
                    "memory_usage": pm2_info.get('memory', 0)
                }
                
        except Exception as e:
            # Fallback status
            for form_number in range(1, 6):
                status[f"form_{form_number}"] = {
                    "galaxy_running": False,
                    "galaxy_pid": None,
                    "status": "unknown",
                    "cpu_usage": 0,
                    "memory_usage": 0
                }
        
        return status
    
    # Get status (use cached or fresh)
    status = get_real_status()
    
    # Update cache
    status_cache["data"] = status
    status_cache["last_update"] = current_time
    
    return jsonify(status), 200

@app.route('/quick-status', methods=['GET'])
def quick_status():
    """Instant status without heavy operations"""
    status = {}
    
    try:
        with process_lock:
            for form_number in range(1, 6):
                process = galaxy_processes[form_number]
                is_alive = process is not None and process.poll() is None
                
                status[f"form_{form_number}"] = {
                    "galaxy_running": is_alive,
                    "galaxy_pid": process.pid if is_alive else None,
                    "process_exists": process is not None
                }
    except:
        for form_number in range(1, 6):
            status[f"form_{form_number}"] = {
                "galaxy_running": False,
                "galaxy_pid": None,
                "process_exists": False
            }
    
    return jsonify(status), 200

@app.route('/health', methods=['GET'])
def health_check():
    """Ultra-fast health check"""
    return jsonify({
        "status": "healthy",
        "timestamp": time.time(),
        "backend_path": GALAXY_BACKEND_PATH,
        "threads_active": executor._threads.__len__() if hasattr(executor, '_threads') else 0
    }), 200

def cleanup_all():
    """Fast cleanup on shutdown"""
    print("Performing fast cleanup...")
    
    # Stop all processes quickly
    cleanup_futures = []
    for form_number in range(1, 6):
        future = executor.submit(force_kill_pm2_process, form_number)
        cleanup_futures.append(future)
    
    # Wait for cleanup with timeout
    for future in cleanup_futures:
        try:
            future.result(timeout=2)
        except:
            pass
    
    # Shutdown executor
    executor.shutdown(wait=False)
    print("Cleanup completed")

def signal_handler(sig, frame):
    cleanup_all()
    exit(0)

if __name__ == '__main__':
    # Register signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Validate environment
    if not os.path.exists(GALAXY_BACKEND_PATH):
        print(f"ERROR: Galaxy backend directory not found at {GALAXY_BACKEND_PATH}")
        exit(1)
    
    # Quick validation of galaxy scripts
    missing_scripts = []
    for form_number in range(1, 6):
        script_path = os.path.join(GALAXY_BACKEND_PATH, f'galaxy_{form_number}.js')
        if not os.path.exists(script_path):
            missing_scripts.append(f'galaxy_{form_number}.js')
    
    if missing_scripts:
        print(f"WARNING: Missing scripts: {', '.join(missing_scripts)}")
    
    print("🚀 High-Performance Galaxy API starting...")
    print(f"📁 Backend Path: {GALAXY_BACKEND_PATH}")
    print(f"🧵 Thread Pool Size: {MAX_WORKERS}")
    print(f"⚡ Optimized for maximum speed!")
    
    # Start Flask with optimized settings
    app.run(
        host='0.0.0.0',
        port=7860,
        debug=False,
        threaded=True,
        processes=1
    )