# RFC8291 Crypto Test Data Setup

This directory contains test data for Web Push (RFC8291) encryption/decryption tests.

## Directory Structure

```
test/data/push/
├── datasets/          # Real test data (gitignored)
│   ├── case1.json    # Test dataset 1
│   └── case2.json    # Test dataset 2
├── examples/          # Example data (committed to repo)
│   └── example.json  # Example dataset with dummy data
└── README.md
```

## Setup Instructions

### Creating test datasets:

1. **Copy example file to create a new dataset:**

   ```bash
   cp examples/example.json datasets/my-test.json
   ```

2. **Replace dummy values with real test data**
   - Edit `datasets/my-test.json`
   - Get real keys and payload from Chrome extension console logs

3. **Run tests:**
   ```bash
   npm test web-push-crypto
   ```

### Adding multiple datasets:

Simply add more JSON files to the `datasets/` directory:

```bash
datasets/case1.json
datasets/case2.json
datasets/user-broadcast.json
datasets/channel-broadcast.json
```

All `.json` files in `datasets/` will be automatically tested.

## Important Security Notes

⚠️ **NEVER commit real test data files to the repository!**

The `datasets/` directory is listed in `.gitignore` to prevent accidental commits of sensitive data.

- `datasets/*.json` - Contains private keys, encrypted payloads, and expected outputs

## File Format

Each dataset is a single JSON file with the following structure:

```json
{
  "keys": {
    "authSecret": "Base64 URL-safe encoded auth secret",
    "publicKey": "Base64 URL-safe encoded public key",
    "privateKey": "Base64 URL-safe encoded private key"
  },
  "payload": {
    "encryptedPayload": "Base64 URL-safe encoded encrypted payload"
  },
  "expected": {
    "decryptedJson": {
      // Expected decrypted JSON structure
    }
  }
}
```

## How to Obtain Real Test Data

1. **Enable logging in the Chrome extension:**
   - Add console.log statements in `web-push-manager.ts`
   - Log keys when generating subscription
   - Log payload when receiving push notification

2. **Capture data from Chrome DevTools:**
   - Open extension background page DevTools
   - Enable push notifications in extension options
   - Check console for logged data
   - Copy values to test data files

3. **Test with captured data:**
   - Verify decryption works with your real data
   - Confirm output matches expected format
