#!/bin/bash

FILE="$1"

# Check if the file exists
if [[ ! -f "$FILE" ]]; then
  echo "File not found: $FILE"
  exit 1
fi

# Check if the file is PEM encoded
if grep -q "BEGIN PRIVATE KEY" "$FILE"; then
  echo "The file is PEM encoded and may be a PKCS#8 private key."
elif grep -q "BEGIN RSA PRIVATE KEY" "$FILE"; then
  echo "The file is PEM encoded but is a traditional RSA private key (not PKCS#8)."
else
  echo "The file is not PEM encoded or does not contain a private key."
  exit 1
fi

# Use openssl to verify the key format
openssl pkcs8 -inform PEM -in "$FILE" -noout 2>/dev/null
if [[ $? -eq 0 ]]; then
  echo "The file is a valid PKCS#8 private key."
else
  echo "The file is not a valid PKCS#8 private key."
fi