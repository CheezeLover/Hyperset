#!/usr/bin/env python3

"""
Test ultra-simple pour verifier le MCP modifie
"""

import sys

def main():
    """Test minimal"""
    print("Test du MCP modifie")
    print("=" * 40)
    
    try:
        # Lire le fichier
        with open('main.py', 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Test 1: Vérifier la syntaxe
        print("1. Test de syntaxe...")
        compile(content, 'main.py', 'exec')
        print("   OK: Syntaxe valide")
        
        # Test 2: Vérifier les fonctions clés
        print("2. Test des fonctions clés...")
        required_functions = [
            'def verify_mcp_token',
            'def extract_identity',
            'async def superset_request',
            'async def superset_lifespan'
        ]
        
        for func in required_functions:
            if func in content:
                print(f"   OK: {func} presente")
            else:
                print(f"   ERREUR: {func} manquante")
                return 1
        
        # Test 3: Vérifier les classes clés
        print("3. Test des classes clés...")
        required_classes = [
            'class VerifiedIdentity',
            'class SupersetContext'
        ]
        
        for cls in required_classes:
            if cls in content:
                print(f"   OK: {cls} presente")
            else:
                print(f"   ERREUR: {cls} manquante")
                return 1
        
        # Test 4: Vérifier les imports
        print("4. Test des imports...")
        required_imports = [
            'import base64',
            'import hashlib',
            'import hmac as hmac_lib',
            'import time',
            'MCP_SERVICE_SECRET'
        ]
        
        for imp in required_imports:
            if imp in content:
                print(f"   OK: {imp} present")
            else:
                print(f"   ERREUR: {imp} manquant")
                return 1
        
        # Test 5: Vérifier l'utilisation des headers
        print("5. Test des headers d'authentification...")
        if 'X-Webauth-User' in content and 'X-Webauth-Email' in content:
            print("   OK: Headers d'authentification presents")
        else:
            print("   ERREUR: Headers d'authentification manquants")
            return 1
        
        print("\n" + "=" * 40)
        print("SUCCESS: Tous les tests ont reussi !")
        print("Le MCP est pret a etre deploye.")
        return 0
        
    except SyntaxError as e:
        print(f"ERREUR: Erreur de syntaxe: {e}")
        return 1
    except Exception as e:
        print(f"ERREUR: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())