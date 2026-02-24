#!/usr/bin/env python3

"""
Script de test pour vérifier que le MCP modifié fonctionne correctement
"""

import sys
import os

# Ajouter le chemin courant au PYTHONPATH
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_syntax():
    """Test la syntaxe du fichier main.py"""
    print("🔍 Test de syntaxe Python...")
    try:
        with open('main.py', 'r', encoding='utf-8') as f:
            code = f.read()
        compile(code, 'main.py', 'exec')
        print("✅ Syntax OK")
        return True
    except SyntaxError as e:
        print(f"❌ Erreur de syntaxe: {e}")
        return False
    except Exception as e:
        print(f"❌ Erreur inattendue: {e}")
        return False

def test_import():
    """Test l'import du module"""
    print("🔍 Test d'import...")
    try:
        import main
        print("✅ Import OK")
        return True
    except ImportError as e:
        print(f"❌ Erreur d'import: {e}")
        return False
    except Exception as e:
        print(f"❌ Erreur lors de l'import: {e}")
        return False

def test_token_verification():
    """Test la fonction de vérification de token"""
    print("🔍 Test de vérification de token...")
    try:
        import main
        import json
        import base64
        import hmac
        import hashlib
        import time
        
        # Créer un token de test valide
        secret = "test_secret_12345678901234567890123456789012"
        os.environ["MCP_SERVICE_SECRET"] = secret
        
        # Recharger le module pour prendre en compte la nouvelle variable d'environnement
        import importlib
        importlib.reload(main)
        
        # Créer un payload
        payload = {
            "sub": "testuser",
            "email": "test@example.com",
            "roles": ["admin"],
            "exp": int(time.time()) + 3600  # Expire dans 1 heure
        }
        
        # Encoder le payload
        encoded_payload = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
        
        # Créer la signature
        signature = hmac.new(
            secret.encode(),
            encoded_payload.encode(),
            hashlib.sha256
        )
        encoded_signature = base64.urlsafe_b64encode(signature.digest()).rstrip(b"=").decode()
        
        # Créer le token
        token = f"{encoded_payload}.{encoded_signature}"
        
        # Tester la vérification
        identity = main.verify_mcp_token(token)
        
        assert identity.username == "testuser"
        assert identity.email == "test@example.com"
        assert identity.roles == ["admin"]
        
        print("✅ Vérification de token OK")
        return True
        
    except Exception as e:
        print(f"❌ Erreur de vérification de token: {e}")
        return False

def main_test():
    """Exécute tous les tests"""
    print("🚀 Début des tests pour le MCP modifié\n")
    
    tests = [
        test_syntax,
        test_import,
        test_token_verification
    ]
    
    results = []
    for test in tests:
        results.append(test())
        print()
    
    if all(results):
        print("🎉 Tous les tests ont réussi !")
        return 0
    else:
        print("💥 Certains tests ont échoué")
        return 1

if __name__ == "__main__":
    sys.exit(main_test())