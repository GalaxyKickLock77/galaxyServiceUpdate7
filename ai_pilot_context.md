🎯 Context for AI/ML Timing Predictor in galaxy_1.js
🧠 Objective
As an AI/ML-based timing predictor, your primary task is to precisely predict the optimal moment to kick a rival player with 99% accuracy. This prediction is executed by the galaxy_1.js gaming automation script. The script targets a safe kicking window between 1200ms to 2000ms. Your timing prediction must fall within this range.

⚙️ Game Mechanics and Rules
Safe Kick Window:
The valid range to kick the opponent is between 1200 ms and 2000 ms (safe window). Kicking outside this range is invalid.

Penalty Rule – Early Kick Error:

If you or your rival attempt a kick too early (within the first 3 seconds), the game server generates a 3-second error penalty.

When this occurs, your model must adjust by slowing down future predictions, increasing predicted times slightly to avoid repeated early kicks.

Rival Detection Events:

Login Detection: Occurs when the rival issues a JOIN or 353 command.

Logout Detection: Captured by observing the PART / SLEEP command linked to the rival's ID.

Kicking Behavior Based on Rival Status:

If the rival logs out (detected logout event), you must predict and trigger a kick within 0–15ms before they leave (prediction time should be equal to this leaving of opponent time but less than of 0 - 15ms margin). This ensures a successful hit before they disappear. THIS IS IMPORTANT FOR PREEMPTIVE KICK OFF AND IT IS MUST AND YOU NEED TO DO THIS WHEN IT IS NEEDED.

If the rival stays online, you must rely entirely on intelligent timing estimation based on previous patterns, ensuring kicks land in the safe zone. THIS IS ALSO MUST IMPORTANT..LONGER STAY THEN THINK AT WHAT TIME IS PERFECT TO KICK.

🤖 Modeling Strategy
Use multiple top-tier ML models (e.g., ensemble of XGBoost, LightGBM, Neural Nets, etc.) to achieve 99% kick accuracy. YES THIS IS ALSO MUST TO USE WORLD BEST ML MODEL FOR THIS GAME..

Prioritize adaptive learning: the model must continuously learn from new login/logout timing patterns and early error feedback. CONSTANT LEARNING IS NEEDED AND IMPLEMENT AT HIGH SPEED.

Apply temporal pattern recognition and real-time sequence modeling to anticipate opponent behavior.

ONE MOST IMPORTANT THING IS IN MANUAL TIME HOW IT DETECT THE RIVAL AND KICKING SAME WE ARE GOING TO USE IT WITH AI SO NO MAJOR CHANGE SHOULD DO IN EXISTING CODE. JUST ONLY IN THE WAITING TIME WE ARE GOING TO USE AI/ML TIMING..

📝 Data Logging (JSON File Requirement)
All predictions and game events must be recorded in a structured JSON file, including:

Timestamps of rival login/logout events

Kick predictions and outcomes

Model confidence score

Early kick penalties (if any)

Adjustments made by the AI model

Performance metrics (e.g., success rate, reaction delay)