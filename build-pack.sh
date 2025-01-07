#!/bin/bash

# Run the build command
yarn turbo run build --filter=@langchain/core

# Navigate to the langchain-core directory
cd langchain-core || { echo "Directory 'langchain-core' not found"; exit 1; }

# Remove the old package.tgz if it exists
if [ -f package.tgz ]; then
  rm package.tgz
  echo "Old package.tgz removed"
else
  echo "No existing package.tgz found"
fi

# Create a new package.tgz
yarn pack

echo "New package.tgz created successfully"

