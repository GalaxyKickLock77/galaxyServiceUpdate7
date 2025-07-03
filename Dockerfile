# Use the custom base image
FROM docker.io/node:18-bullseye

# Set the working directory in the container
WORKDIR /galaxybackend

# Install additional required packages
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    sudo \
    lsof \  
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Flask and Flask-CORS
RUN pip3 install flask flask-cors flask_socketio

# Copy your application files into the container
COPY package*.json ./
COPY . .


# Install PM2 globally
RUN npm install -g pm2 && \
    npm install crypto-js \
    npm install node-fetch

EXPOSE 7860
# Command to run the deployment script, then start the Python app
CMD ["sh", "-c", "python3 /galaxybackend/app.py"]
