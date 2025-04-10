'use strict';

const { Config, Broadcast: B } = require('ranvier');
const Combat = require('./lib/Combat');
const CombatErrors = require('./lib/CombatErrors');
const LevelUtil = require('../hylands-lib/lib/LevelUtil');

// Check if websocket-networking is available
let WebsocketStream;
try {
  WebsocketStream = require('../websocket-networking/lib/WebsocketStream');
} catch (e) {
  // If websocket-networking is not available, use a dummy class
  WebsocketStream = class DummyWebsocketStream {};
}

/**
 * Auto combat module
 */
module.exports = {
  listeners: {
    updateTick: state => function () {
      Combat.startRegeneration(state, this);

      let hadActions = false;
      try {
        hadActions = Combat.updateRound(state, this);
      } catch (e) {
        if (e instanceof CombatErrors.CombatInvalidTargetError) {
          B.sayAt(this, "You can't attack that target.");
        } else {
          throw e;
        }
      }

      if (!hadActions) {
        return;
      }

      const usingWebsockets = this.socket instanceof WebsocketStream;
      // don't show the combat prompt to a websockets server
      if (!this.hasPrompt('combat') && !usingWebsockets) {
        this.addPrompt('combat', _ => promptBuilder(this));
      }

      B.sayAt(this, '');
      if (!usingWebsockets) {
        B.prompt(this);
      }
    },

    /**
     * When the player hits a target
     * @param {Damage} damage
     * @param {Character} target
     */
    hit: state => function (damage, target, finalAmount) {
      if (damage.metadata.hidden) {
        return;
      }

      let buf = '';
      if (damage.source !== this) {
        buf = `Your <b>${damage.source.name}</b> hit`;
      } else {
        buf = "You hit";
      }

      buf += ` <b>${target.name}</b> for <b>${finalAmount}</b> damage.`;

      if (damage.metadata.critical) {
        buf += ' <red><b>(Critical)</b></red>';
      }

      B.sayAt(this, buf);

      if (this.equipment.has('wield')) {
        this.equipment.get('wield').emit('hit', damage, target, finalAmount);
      }

      // show damage to party members
      if (!this.party) {
        return;
      }

      for (const member of this.party) {
        if (member === this || member.room !== this.room) {
          continue;
        }

        let buf = '';
        if (damage.source !== this) {
          buf = `${this.name} <b>${damage.source.name}</b> hit`;
        } else {
          buf = `${this.name} hit`;
        }

        buf += ` <b>${target.name}</b> for <b>${finalAmount}</b> damage.`;
        B.sayAt(member, buf);
      }
    },

    /**
     * @param {Heal} heal
     * @param {Character} target
     */
    heal: state => function (heal, target) {
      if (heal.metadata.hidden) {
        return;
      }

      if (target !== this) {
        let buf = '';
        if (heal.source !== this) {
          buf = `Your <b>${heal.source.name}</b> healed`;
        } else {
          buf = "You heal";
        }

        buf += `<b> ${target.name}</b> for <b><green>${finalAmount}</green></b> ${heal.attribute}.`;
        B.sayAt(this, buf);
      }

      // show heals to party members
      if (!this.party) {
        return;
      }

      for (const member of this.party) {
        if (member === this || member.room !== this.room) {
          continue;
        }

        let buf = '';
        if (heal.source !== this) {
          buf = `${this.name} <b>${heal.source.name}</b> healed`;
        } else {
          buf = `${this.name} healed`;
        }

        buf += ` <b>${target.name}</b>`;
        buf += ` for <b><green>${finalAmount}</green></b> ${heal.attribute}.`;
        B.sayAt(member, buf);
      }
    },

    damaged: state => function (damage, finalAmount) {
      if (damage.metadata.hidden || damage.attribute !== 'health') {
        return;
      }

      let buf = '';
      if (damage.attacker) {
        buf = `<b>${damage.attacker.name}</b>`;
      }

      if (damage.source !== damage.attacker) {
        buf += (damage.attacker ? "'s " : " ") + `<b>${damage.source.name}</b>`;
      } else if (!damage.attacker) {
        buf += "Something";
      }

      buf += ` hit <b>You</b> for <b><red>${finalAmount}</red></b> damage.`;

      if (damage.metadata.critical) {
        buf += ' <red><b>(Critical)</b></red>';
      }

      B.sayAt(this, buf);

      if (this.party) {
        // show damage to party members
        for (const member of this.party) {
          if (member === this || member.room !== this.room) {
            continue;
          }

          let buf = '';
          if (damage.attacker) {
            buf = `<b>${damage.attacker.name}</b>`;
          }

          if (damage.source !== damage.attacker) {
            buf += (damage.attacker ? "'s " : ' ') + `<b>${damage.source.name}</b>`;
          } else if (!damage.attacker) {
            buf += "Something";
          }

          buf += ` hit <b>${this.name}</b> for <b><red>${finalAmount}</red></b> damage`;
          B.sayAt(member, buf);
        }
      }

      if (this.getAttribute('health') <= 0) {
        Combat.handleDeath(state, this, damage.attacker);
      }
    },

    healed: state => function (heal, finalAmount) {
      if (heal.metadata.hidden) {
        return;
      }

      let buf = '';
      let attacker = '';
      let source = '';

      if (heal.attacker && heal.attacker !== this) {
        attacker = `<b>${heal.attacker.name}</b> `;
      }

      if (heal.source !== heal.attacker) {
        attacker = attacker ? attacker + "'s " : '';
        source = `<b>${heal.source.name}</b>`;
      } else if (!heal.attacker) {
        source = "Something";
      }

      if (heal.attribute === 'health') {
        buf = `${attacker}${source} heals you for <b><red>${finalAmount}</red></b>.`;
      } else {
        buf = `${attacker}${source} restores <b>${finalAmount}</b> ${heal.attribute}.`;
      }
      B.sayAt(this, buf);

      // show heal to party members only if it's to health and not restoring a different pool
      if (!this.party || heal.attribute !== 'health') {
        return;
      }

      for (const member of this.party) {
        if (member === this || member.room !== this.room) {
          continue;
        }

        let buf = `${attacker}${source} heals ${this.name} for <b><red>${finalAmount}</red></b>.`;
        B.sayAt(member, buf);
      }
    },

    /**
     * Player was killed
     * @param {Character} killer
     */
     killed: state => {
       const startingRoomRef = Config.get('startingRoom');
       if (!startingRoomRef) {
         Logger.error('No startingRoom defined in ranvier.json');
       }

       return function (killer) {
        this.removePrompt('combat');

        const othersDeathMessage = killer ?
          `<b><red>${this.name} collapses to the ground, dead at the hands of ${killer.name}.</b></red>` :
          `<b><red>${this.name} collapses to the ground, dead</b></red>`;

        B.sayAtExcept(this.room, othersDeathMessage, (killer ? [killer, this] : this));

        if (this.party) {
          B.sayAt(this.party, `<b><green>${this.name} was killed!</green></b>`);
        }

        this.setAttributeToMax('health');

        let home = state.RoomManager.getRoom(this.getMeta('waypoint.home'));
        if (!home) {
          home = state.RoomManager.getRoom(startingRoomRef);
        }

        this.moveTo(home, _ => {
          state.CommandManager.get('look').execute(null, this);

          B.sayAt(this, '<b><red>Whoops, that sucked!</red></b>');
          if (killer && killer !== this) {
            B.sayAt(this, `You were killed by ${killer.name}.`);
          }
          // player loses 20% exp gained this level on death
          const lostExp = Math.floor(this.experience * 0.2);
          this.experience -= lostExp;
          this.save();
          B.sayAt(this, `<red>You lose <b>${lostExp}</b> experience!</red>`);

          B.prompt(this);
        });
      };
    },

    /**
     * Player killed a target
     * @param {Character} target
     */
    deathblow: state => function (target, skipParty) {
      const xp = LevelUtil.mobExp(target.level);
      if (this.party && !skipParty) {
        // if they're in a party proxy the deathblow to all members of the party in the same room.
        // this will make sure party members get quest credit trigger anything else listening for deathblow
        for (const member of this.party) {
          if (member.room === this.room) {
            member.emit('deathblow', target, true);
          }
        }
        return;
      }

      if (target && !this.isNpc) {
        B.sayAt(this, `<b><red>You killed ${target.name}!</red></b>`);
      }

      this.emit('experience', xp);
    }
  }
};

function promptBuilder(promptee) {
  if (!promptee.isInCombat()) {
    return '';
  }

  // Set up some constants for formatting the health bars
  const playerName = "You";
  const targetNameLengths = [...promptee.combatants].map(t => t.name.length);
  const nameWidth = Math.max(playerName.length, ...targetNameLengths);
  const progWidth = 60 - (nameWidth + ':  ').length;

  // Set up helper functions for health-bar-building.
  const getHealthPercentage = entity => Math.floor((entity.getAttribute('health') / entity.getMaxAttribute('health')) * 100);
  const formatProgressBar = (name, progress, entity) => {
    const pad = B.line(nameWidth - name.length, ' ');
    return `<b>${name}${pad}</b>: ${progress} <b>${entity.getAttribute('health')}/${entity.getMaxAttribute('health')}</b>`;
  }

  // Build player health bar.
  let currentPerc = getHealthPercentage(promptee);
  let progress = B.progress(progWidth, currentPerc, "green");
  let buf = formatProgressBar(playerName, progress, promptee);

  // Build and add target health bars.
  for (const target of promptee.combatants) {
    let currentPerc = Math.floor((target.getAttribute('health') / target.getMaxAttribute('health')) * 100);
    let progress = B.progress(progWidth, currentPerc, "red");
    buf += `\r\n${formatProgressBar(target.name, progress, target)}`;
  }

  return buf;
}
