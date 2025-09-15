# Use a base image with Python installed
FROM python:3.10-slim

# Set the working directory in the container
WORKDIR /app

# Copy and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the entire application code into the container
# This assumes your sim code is in a 'sim' directory
COPY . .

# Command to run the simulation engine
# By default, it will try to connect to AirSim.
# To run in sim-only mode, you would override this command.
CMD ["python", "-m", "sim.engine"]
