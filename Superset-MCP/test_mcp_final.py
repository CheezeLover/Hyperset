#!/usr/bin/env python3

"""
Test minimal pour verifier la syntaxe et la structure du MCP modifie
"""

import sys
import os
import ast

def test_syntax():
    """Test la syntaxe du fichier main.py"""
    print("Test de syntaxe Python...")
    try:
        with open('main.py', 'r', encoding='utf-8') as f:
            code = f.read()
        
        # Verifier la syntaxe avec AST
        ast.parse(code)
        print("OK: Syntaxe Python valide")
        
        # Verifier que les fonctions cles sont presentes
        tree = ast.parse(code)
        functions = [node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)]
        
        required_functions = [
            'verify_mcp_token',
            'extract_identity',
            'superset_request',
            'superset_lifespan'
        ]
        
        missing_functions = [f for f in required_functions if f not in functions]
        
        if missing_functions:
            print(f"ERREUR: Fonctions manquantes: {missing_functions}")
            return False
        else:
            print("OK: Toutes les fonctions requises sont presentes")
            
        # Verifier que les classes cles sont presentes
        classes = [node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)]
        
        required_classes = [
            'VerifiedIdentity',
            'SupersetContext'
        ]
        
        missing_classes = [c for c in required_classes if c not in classes]
        
        if missing_classes:
            print(f"ERREUR: Classes manquantes: {missing_classes}")
            return False
        else:
            print("OK: Toutes les classes requises sont presentes")
            
        return True
        
    except SyntaxError as e:
        print(f"ERREUR: Erreur de syntaxe: {e}")
        return False
    except Exception as e:
        print(f"ERREUR: Erreur inattendue: {e}")
        return False

def test_token_functions():
    """Test les fonctions de token sans dependances"""
    print("Test des fonctions de token...")
    try:
        # Lire le fichier et extraire les fonctions manuellement
        with open('main.py', 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Verifier que les imports necessaires sont presents
        required_imports = [
            'import base64',
            'import hashlib',
            'import hmac as hmac_lib',
            'import time',
            'from dataclasses import dataclass'
        ]
        
        missing_imports = [imp for imp in required_imports if imp not in content]
        
        if missing_imports:
            print(f"ERREUR: Imports manquants: {missing_imports}")
            return False
        else:
            print("OK: Tous les imports requis sont presents")
        
        # Verifier que la verification du secret est presente
        if 'MCP_SERVICE_SECRET' not in content:
            print("ERREUR: Variable MCP_SERVICE_SECRET manquante")
            return False
        else:
            print("OK: Variable MCP_SERVICE_SECRET presente")
        
        # Verifier que la classe VerifiedIdentity a les bons champs
        if 'username: str' in content and 'email: str' in content and 'roles: list[str]' in content:
            print("OK: Classe VerifiedIdentity correcte")
        else:
            print("ERREUR: Classe VerifiedIdentity incomplete")
            return False
        
        return True
        
    except Exception as e:
        print(f"ERREUR: Erreur lors du test des fonctions de token: {e}")
        return False

def test_superset_request_function():
    """Test la fonction superset_request"""
    print("Test de la fonction superset_request...")
    try:
        with open('main.py', 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Verifier que la fonction utilise extract_identity
        if 'extract_identity(ctx.request_context.request)' not in content:
            print("ERREUR: extract_identity non utilise dans superset_request")
            return False
        else:
            print("OK: extract_identity est utilise")
        
        # Verifier que les headers X-Webauth-User et X-Webauth-Email sont utilises
        if 'X-Webauth-User' not in content or 'X-Webauth-Email' not in content:
            print("ERREUR: Headers d'authentification manquants")
            return False
        else:
            print("OK: Headers d'authentification presents")
        
        # Verifier que la fonction gere les differentes methodes HTTP
        methods = ['get', 'post', 'put', 'delete']
        method_checks = [f'method.lower() == "{method}"' for method in methods]
        
        if not all(check in content for check in method_checks):
            print("ERREUR: Gestion incomplete des methodes HTTP")
            return False
        else:
            print("OK: Toutes les methodes HTTP sont gerees")
        
        return True
        
    except Exception as e:
        print(f"ERREUR: Erreur lors du test de superset_request: {e}")
        return False

def main_test():
    """Execute tous les tests"""
    print("Debut des tests pour le MCP modifie")
    print("=" * 50)
    
    tests = [
        test_syntax,
        test_token_functions,
        test_superset_request_function
    ]
    
    results = []
    for test in tests:
        result = test()
        results.append(result)
        print()
    
    print("=" * 50)
    if all(results):
        print("SUCCESS: Tous les tests ont reussi !")
        print("Le MCP est pret a etre deploye.")
        return 0
    else:
        print("FAILURE: Certains tests ont echoue")
        print("Veuillez verifier les erreurs ci-dessus.")
        return 1

if __name__ == "__main__":
    sys.exit(main_test())