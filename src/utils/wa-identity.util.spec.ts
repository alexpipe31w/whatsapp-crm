import {
  isLidIdentity, lidIdentity, lidFromIdentity,
  resolveJid, phoneFromJid, lidUserFromJid, jidFromPhone,
} from './wa-identity.util';

describe('wa-identity', () => {
  describe('resolveJid', () => {
    it('prefiere el jid con teléfono cuando WhatsApp lo entrega', () => {
      expect(resolveJid({ remoteJid: '118442917159121@lid', remoteJidAlt: '573152408317@s.whatsapp.net' }))
        .toBe('573152408317@s.whatsapp.net');
    });

    it('devuelve el LID tal cual cuando no hay alternativa con número', () => {
      expect(resolveJid({ remoteJid: '118442917159121@lid' })).toBe('118442917159121@lid');
    });
  });

  describe('phoneFromJid', () => {
    it('extrae el teléfono y descarta el sufijo de dispositivo', () => {
      expect(phoneFromJid('573152408317@s.whatsapp.net')).toBe('+573152408317');
      expect(phoneFromJid('573152408317:26@s.whatsapp.net')).toBe('+573152408317');
    });

    it('no inventa teléfono a partir de un LID', () => {
      expect(phoneFromJid('118442917159121@lid')).toBeNull();
      expect(phoneFromJid('')).toBeNull();
    });
  });

  describe('lidUserFromJid', () => {
    it('extrae el usuario LID con y sin dispositivo', () => {
      expect(lidUserFromJid('118442917159121@lid')).toBe('118442917159121');
      expect(lidUserFromJid('118442917159121:3@lid')).toBe('118442917159121');
    });

    it('rechaza lo que no es un LID numérico', () => {
      expect(lidUserFromJid('573152408317@s.whatsapp.net')).toBeNull();
      expect(lidUserFromJid('abc@lid')).toBeNull();
      expect(lidUserFromJid('')).toBeNull();
    });
  });

  describe('identidad', () => {
    it('distingue una identidad LID de un teléfono', () => {
      expect(isLidIdentity(lidIdentity('118442917159121'))).toBe(true);
      expect(isLidIdentity('+573152408317')).toBe(false);
    });

    it('recupera el LID de la identidad y no de un teléfono', () => {
      expect(lidFromIdentity('lid:118442917159121')).toBe('118442917159121');
      expect(lidFromIdentity('+573152408317')).toBeNull();
    });
  });

  describe('jidFromPhone', () => {
    it('arma la dirección telefónica normal', () => {
      expect(jidFromPhone('+57 315 240 8317')).toBe('573152408317@s.whatsapp.net');
    });

    it('responde al LID cuando el cliente no tiene número', () => {
      expect(jidFromPhone('lid:118442917159121')).toBe('118442917159121@lid');
    });

    it('ida y vuelta: el jid de una identidad LID vuelve a dar el mismo LID', () => {
      const jid = jidFromPhone(lidIdentity('118442917159121'));
      expect(lidUserFromJid(jid)).toBe('118442917159121');
    });
  });
});
