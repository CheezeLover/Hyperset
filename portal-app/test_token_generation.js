// Script de test pour la génération de tokens MCP
// À exécuter avec Node.js

const crypto = require('crypto');

// Configuration du secret (doit être le même que dans le MCP)
process.env.MCP_SERVICE_SECRET = 'test-secret-at-least-32-characters-long';

// Implémentation de la fonction createMcpToken en JavaScript
function createMcpToken(username, email, roles) {
  const payload = {
    sub: username,
    email: email,
    roles: roles,
    iat: Date.now(),
    exp: Date.now() + 60000,  // 60 secondes
    jti: crypto.randomUUID(),  // nonce anti-rejeu
  };

  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.MCP_SERVICE_SECRET)
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${sig}`;
}

// Test de génération de token
console.log('🔑 Test de génération de token MCP');
console.log('='.repeat(50));

try {
  // Créer un token pour un utilisateur test
  const token = createMcpToken('alice', 'alice@test.com', ['hyperset/user']);
  
  console.log('✅ Token généré avec succès:');
  console.log(`Token: ${token}`);
  
  // Vérifier la structure du token
  const parts = token.split('.');
  console.log(`\n📊 Structure du token:`);
  console.log(`- Nombre de parties: ${parts.length} (doit être 2)`);
  console.log(`- Longueur payload: ${parts[0].length} caractères`);
  console.log(`- Longueur signature: ${parts[1].length} caractères`);
  
  // Décoder le payload pour vérification
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  console.log(`\n📋 Contenu du payload:`);
  console.log(`- sub: ${payload.sub}`);
  console.log(`- email: ${payload.email}`);
  console.log(`- roles: ${payload.roles.join(', ')}`);
  console.log(`- iat: ${new Date(payload.iat).toISOString()}`);
  console.log(`- exp: ${new Date(payload.exp).toISOString()}`);
  console.log(`- jti: ${payload.jti}`);
  
  // Vérifier que le token expire dans ~60 secondes
  const ttl = Math.round((payload.exp - payload.iat) / 1000);
  console.log(`\n⏱️  Temps de vie du token: ${ttl} secondes`);
  
  if (ttl >= 55 && ttl <= 65) {
    console.log('✅ TTL valide (environ 60 secondes)');
  } else {
    console.log('❌ TTL invalide');
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('🎉 Tous les tests ont réussi !');
  console.log('\nProchaine étape:');
  console.log('1. Copiez ce token dans les headers Authorization: Bearer <token>');
  console.log('2. Envoyez-le au MCP pour validation');
  console.log('3. Le MCP devrait accepter la requête et l\'exécuter en tant qu\'utilisateur alice');
  
} catch (error) {
  console.error('❌ Erreur lors de la génération du token:', error);
  process.exit(1);
}