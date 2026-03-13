#!/usr/bin/env python3
"""
Test script for the Google OAuth API endpoint.
Tests the full OAuth flow including authentication and folder operations.
Reads credentials from .env file.
"""

import httpx
import json
import os
import sys
import time
import webbrowser
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env
env_path = Path(__file__).parent.parent.parent.parent / ".env"
load_dotenv(env_path)

API_BASE = "http://localhost:8000"
HANDOFF_FILE_DIR = os.getenv("HANDOFF_DIR", "./data")
AUTH_TIMEOUT_SECS = 120


def _get_handoff_path():
    """Get the path to the handoff file."""
    return os.path.join(HANDOFF_FILE_DIR, "latest_auth.json")


def test_full_oauth_flow():
    """Test the complete OAuth flow with browser authentication."""
    print("Testing Full OAuth Flow (with browser authentication)...")
    print("=" * 60)
    
    # Read credentials from .env
    client_id = os.getenv("GOOGLE_CLIENT_ID")
    client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.getenv("OAUTH_REDIRECT_URI", "http://localhost:8000/auth/google/callback")
    
    if not client_id or not client_secret:
        print("\n✗ ERROR: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not found in .env")
        return False, None
    
    # Remove any leftover handoff file
    handoff_path = _get_handoff_path()
    if os.path.exists(handoff_path):
        os.remove(handoff_path)
    
    # Step 1: Initiate OAuth flow
    print("\nStep 1: Calling POST /auth/google/start...")
    print(f"Client ID: {client_id[:20]}...")
    
    test_data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri
    }
    
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f"{API_BASE}/auth/google/start",
                json=test_data
            )
            
            if response.status_code != 200:
                print(f"\n✗ FAILED with status {response.status_code}")
                print(f"Response: {response.text}")
                return False, None
            
            data = response.json()
            auth_url = data.get("auth_url")
            user_id = data.get("user_id")
            
            if not auth_url or not user_id:
                print("\n✗ Response missing auth_url or user_id")
                return False, None
            
            print(f"✓ Got auth_url and user_id: {user_id[:20]}...")
            
    except httpx.ConnectError:
        print("\n✗ ERROR: Could not connect to API")
        print("Make sure the server is running: docker compose up")
        return False, None
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        return False, None
    
    # Step 2: Open browser for authentication
    print("\nStep 2: Opening browser for authentication...")
    print(f"URL: {auth_url[:80]}...")
    print()
    
    try:
        webbrowser.open(auth_url)
        print("✓ Browser opened")
    except Exception as e:
        print(f"⚠ Could not open browser automatically: {e}")
        print(f"\nPlease open this URL in your browser:")
        print(f"  {auth_url}")
    
    print()
    print(f"⏳ Waiting for you to complete authentication (timeout: {AUTH_TIMEOUT_SECS}s)...")
    print("   (Complete the OAuth flow in your browser)")
    print()
    
    # Step 3: Wait for callback completion
    deadline = time.time() + AUTH_TIMEOUT_SECS
    dots = 0
    while time.time() < deadline:
        if os.path.exists(handoff_path):
            try:
                with open(handoff_path) as f:
                    handoff_data = json.load(f)
                returned_user_id = handoff_data.get("user_id", "").strip()
                if returned_user_id == user_id:
                    os.remove(handoff_path)
                    print("\n✓ Authentication complete!")
                    print(f"✓ user_id verified: {user_id}")
                    return True, user_id
            except (json.JSONDecodeError, IOError):
                pass
        
        # Progress indicator
        dots = (dots + 1) % 4
        sys.stdout.write(f"\rWaiting{'.' * dots}{' ' * (3 - dots)}")
        sys.stdout.flush()
        time.sleep(1)
    
    print("\n\n✗ Timed out waiting for authentication")
    return False, None



def test_health_endpoint():
    """Test the health endpoint to verify server is running."""
    print("\nTesting server health...")
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(f"{API_BASE}/health")
            if response.status_code == 200:
                print("✓ Server is running")
                return True
            else:
                print(f"✗ Health check failed: {response.status_code}")
                return False
    except httpx.ConnectError:
        print("✗ Server is not running")
        return False


def extract_folder_id(folder_link):
    """Extract folder ID from Google Drive link."""
    import re
    
    # Try to match /folders/ID pattern
    match = re.search(r'/folders/([a-zA-Z0-9_-]+)', folder_link)
    if match:
        return match.group(1)
    
    # Try to match ?id=ID pattern
    match = re.search(r'[?&]id=([a-zA-Z0-9_-]+)', folder_link)
    if match:
        return match.group(1)
    
    # Assume it's already an ID
    return folder_link.strip()


def test_folder_list(user_id, folder_link):
    """Test listing files in a folder (requires authentication)."""
    print("\n" + "=" * 60)
    print("Testing GET /folders/list endpoint...")
    print("=" * 60)
    print(f"\nFolder link: {folder_link}")
    print(f"User ID: {user_id[:20]}...")
    
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(
                f"{API_BASE}/folders/list",
                headers={"Authorization": f"Bearer {user_id}"},
                params={"folder_link": folder_link, "recursive": False}
            )
            
            print(f"\nResponse status: {response.status_code}")
            
            if response.status_code == 200:
                data = response.json()
                print(f"\n✓ SUCCESS! Found {len(data)} files")
                if data:
                    print("\nFirst few files:")
                    for f in data[:3]:
                        print(f"  - {f.get('name')} ({f.get('mime_type')})")
                else:
                    print("  (Folder is empty)")
                return True
            else:
                print(f"\n✗ FAILED with status {response.status_code}")
                print(f"Response: {response.text}")
                return False
                
    except httpx.ConnectError:
        print("\n✗ ERROR: Could not connect to API")
        return False
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        return False


def test_folder_sync(user_id, folder_link):
    """Test syncing a folder (requires authentication)."""
    print("\n" + "=" * 60)
    print("Testing POST /folders/sync endpoint (dry run)...")
    print("=" * 60)
    print(f"\nFolder link: {folder_link}")
    print(f"User ID: {user_id[:20]}...")
    
    try:
        with httpx.Client(timeout=60.0) as client:
            response = client.post(
                f"{API_BASE}/folders/sync",
                headers={"Authorization": f"Bearer {user_id}"},
                json={
                    "folder_link": folder_link,
                    "recursive": False,
                    "dry_run": True,  # Don't actually download
                    "index": False
                }
            )
            
            print(f"\nResponse status: {response.status_code}")
            
            if response.status_code == 200:
                data = response.json()
                print(f"\n✓ SUCCESS! Dry run completed")
                print(f"  - Files found: {data.get('files_found')}")
                print(f"  - Files uploaded: {data.get('files_uploaded')}")
                print(f"  - Errors: {len(data.get('errors', []))}")
                return True
            else:
                print(f"\n✗ FAILED with status {response.status_code}")
                print(f"Response: {response.text}")
                return False
                
    except httpx.ConnectError:
        print("\n✗ ERROR: Could not connect to API")
        return False
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        return False


def main():
    print("\n" + "=" * 60)
    print("  Google OAuth API - Full Integration Test")
    print("=" * 60)
    print("\nThis test will:")
    print("  1. Check if server is running")
    print("  2. Initiate OAuth flow and open browser")
    print("  3. Wait for you to authenticate")
    print("  4. Test folder listing with authenticated user")
    print("  5. Test folder sync (dry run)")
    print("\n" + "=" * 60 + "\n")
    
    # Check if server is running
    if not test_health_endpoint():
        print("\n✗ Server is not running")
        print("Please start the server first: docker compose up")
        sys.exit(1)
    
    # Test the full OAuth flow with browser authentication
    print()
    success, user_id = test_full_oauth_flow()
    
    if not success or not user_id:
        print("\n" + "=" * 60)
        print("  Authentication failed! ✗")
        print("=" * 60 + "\n")
        sys.exit(1)
    
    # Test folder operations if folder link is provided in .env
    folder_link = os.getenv("GOOGLE_FOLDER_LINK")
    if not folder_link:
        print("\n⚠ GOOGLE_FOLDER_LINK not set in .env")
        print("Skipping folder tests")
        print("\n" + "=" * 60)
        print("  Authentication test passed! ✓")
        print("=" * 60 + "\n")
        sys.exit(0)
    
    # Test folder listing
    list_result = test_folder_list(user_id, folder_link)
    if not list_result:
        print("\n" + "=" * 60)
        print("  Folder listing test failed! ✗")
        print("=" * 60 + "\n")
        sys.exit(1)
    
    # Test folder sync (dry run)
    sync_result = test_folder_sync(user_id, folder_link)
    if not sync_result:
        print("\n" + "=" * 60)
        print("  Folder sync test failed! ✗")
        print("=" * 60 + "\n")
        sys.exit(1)
    
    print("\n" + "=" * 60)
    print("  🎉 All tests passed! ✓")
    print("=" * 60)
    print("\nSummary:")
    print("  ✓ Server health check")
    print("  ✓ OAuth authentication flow")
    print("  ✓ Folder listing")
    print("  ✓ Folder sync (dry run)")
    print("\n" + "=" * 60 + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
