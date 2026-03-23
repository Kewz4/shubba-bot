# Use an official Node.js runtime as the base image
# Slim version is preferred for faster deployments on Cloud Run
FROM node:18-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json (if available)
# Doing this before copying the full code allows Docker to cache dependencies
COPY package*.json ./

# Install production dependencies
RUN npm install --production

# Copy the rest of your bot's source code
COPY . .

# Start the bot using the command defined in your package.json
CMD [ "npm", "start" ]