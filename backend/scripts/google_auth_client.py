#!/usr/bin/env python3
"""
Google OAuth client script with automatic browser launch.
Accepts client_id and client_secret as arguments, calls the API,
and automatically opens the browser for authentication.
"""

import argparse
import json
import os
import sys
import time
import webbrowser

import httpx

API_BASE = os.getenv("API_BASE_URL", "http://localhost:8000")
HANDOFF_FILE_DIR = os.getenv("HANDOFF_DIR", "./data")
AUTH_TIMEOUT_SECS = 120


def _get_handoff_path() -> str:
    """Get the path to the handoff file."""
    return os.path.join(HANDOFF_FILE_DIR, "latest_auth.json")


def authenticate(client_id: str, client_secret: str, redirect_uri: str) -> str:
    """
    Initiate OAuth flow and return user_id upon completion.
    
    Args:
        client_id: Google OAuth client ID
        client_secret: Google OAuth client secret
        redirect_uri: OAuth redirect URI (callback URL)
    
    Returns:
        user_id: The assigned user ID after successful authentication
    """
    handoff_path = _get_handoff_path()
    
    # Remove any leftover handoff file from a previous auth
    if os.path.exists(handoff_path):
        os.remove(handoff_path)
    
    print()
    print("=" * 60)
    print("  Google OAuth Authentication")
    print("=" * 60)
    print()
    
    # Step 1: Call the API to initiate OAuth flow
    print("Step 1: Initiating OAuth flow...")
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                f"{API_BASE}/auth/google/start",
                json={
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "redirect_uri": redirect_uri,
                }
            )
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as e:
        print(f"Error calling API: {e}")
        sys.exit(1)
    
    auth_url = data.get("auth_url")
    user_id = data.get("user_id")
    
    if not auth_url or not user_id:
        print("Error: Invalid response from API")
        print(f"Response: {data}")
        sys.exit(1)
    
    print(f"✓ OAuth flow initiated (user_id: {user_id})")
    print()
    
    # Step 2: Open browser automatically
    print("Step 2: Launching browser for authentication...")
    print(f"URL: {auth_url}")
    print()
    
    try:
        webbrowser.open(auth_url)
        print("✓ Browser launched successfully")
    except Exception as e:
        print(f"Warning: Could not open browser automatically: {e}")
        print()
        print("Please open this URL manually in your browser:")
        print(f"  {auth_url}")
    
    print()
    print(f"Waiting for you to complete authentication (timeout: {AUTH_TIMEOUT_SECS}s)...")
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
                    print()
                    print("=" * 60)
                    print(f"  SUCCESS: user_id = {user_id}")
                    print("=" * 60)
                    print()
                    return user_id
            except (json.JSONDecodeError, IOError):
                pass
        
        # Progress indicator
        dots = (dots + 1) % 4
        sys.stdout.write(f"\rWaiting{'.' * dots}{' ' * (3 - dots)}")
        sys.stdout.flush()
        time.sleep(1)
    
    print("\n")
    print("✗ Timed out waiting for authentication.")
    print()
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Google OAuth authentication with automatic browser launch",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --client-id YOUR_CLIENT_ID --client-secret YOUR_SECRET
  
  %(prog)s \\
    --client-id 123.apps.googleusercontent.com \\
    --client-secret GOCSPX-abc123 \\
    --redirect-uri http://localhost:8000/auth/google/callback

Environment Variables:
  API_BASE_URL     Base URL of the API (default: http://localhost:8000)
  HANDOFF_DIR      Directory for handoff file (default: ./data)
        """
    )
    
    parser.add_argument(
        "--client-id",
        required=True,
        help="Google OAuth client ID"
    )
    
    parser.add_argument(
        "--client-secret",
        required=True,
        help="Google OAuth client secret"
    )
    
    parser.add_argument(
        "--redirect-uri",
        default="http://localhost:8000/auth/google/callback",
        help="OAuth redirect URI (default: http://localhost:8000/auth/google/callback)"
    )
    
    args = parser.parse_args()
    
    user_id = authenticate(
        client_id=args.client_id,
        client_secret=args.client_secret,
        redirect_uri=args.redirect_uri
    )
    
    print(f"You can now use this user_id for API calls: {user_id}")
    print()


if __name__ == "__main__":
    main()
