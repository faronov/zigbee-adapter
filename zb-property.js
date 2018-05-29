/**
 * Zigbee Property.
 *
 * Object which decscribes a property, and its value.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const Color = require('color');
const zclId = require('zcl-id');

let Deferred, Property, utils;
try {
  Deferred = require('../deferred');
  Property = require('../property');
  utils = require('../utils');
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') {
    throw e;
  }

  const gwa = require('gateway-addon');
  Deferred = gwa.Deferred;
  Property = gwa.Property;
  utils = gwa.Utils;
}

/**
 * @function levelToPercent
 *
 * Converts a light level in the range 0-254 into a percentage using
 * linear interpolation.
 */
function levelToPercent(level) {
  if (level < 1) {
    return 0;
  }
  return Math.min(level * 100 / 254, 100);
}

/**
 * @function percentToLevel
 *
 * Inverse of the levelToPercent function. Takes a percentage in the range
 * 0-100 and converts it into a level in the range 0-254.
 */
function percentToLevel(percent) {
  if (percent < 0.1) {
    return 0;
  }
  return Math.min(Math.round(percent * 254 / 100), 254);
}

class ZigbeeProperty extends Property {
  constructor(device, name, propertyDescr, profileId, endpoint, clusterId, attr,
              setAttrFromValue, parseValueFromAttr) {
    super(device, name, propertyDescr);

    this.profileId = profileId;
    this.endpoint = endpoint;
    this.clusterId = clusterId;
    if (setAttrFromValue) {
      this.setAttrFromValue = Object.getPrototypeOf(this)[setAttrFromValue];
      if (!this.setAttrFromValue) {
        const err = `Unknown function: ${setAttrFromValue}`;
        console.error(err);
        throw err;
      }
    }
    if (parseValueFromAttr) {
      this.parseValueFromAttr = Object.getPrototypeOf(this)[parseValueFromAttr];
      if (!this.parseValueFromAttr) {
        const err = `Unknown function: ${parseValueFromAttr}`;
        console.error(err);
        throw err;
      }
    }
    const attrs = attr.split(',');
    if (attrs.length > 1) {
      this.attr = attrs;
      this.attrId = [];
      for (const attr of attrs) {
        this.attrId.push(zclId.attr(clusterId, attr).value);
      }
    } else {
      this.attr = attr;
      this.attrId = zclId.attr(clusterId, attr).value;
    }
    this.fireAndForget = false;
  }

  asDict() {
    const dict = super.asDict();
    dict.profileId = this.profileId;
    dict.endpoint = this.endpoint;
    dict.clusterId = this.clusterId;
    dict.attr = this.attr;
    dict.value = this.value;
    dict.fireAndForget = this.fireAndForget;
    if (this.hasOwnProperty('level')) {
      dict.level = this.level;
    }
    return dict;
  }

  /**
   * @method parseAttrEntry
   *
   * Parses the attribute data received via ZCL and converts it into
   * a property value.
   *
   * @param attrEntry - An attribute entry from the zcl-packet library
   *    readRsp which will look something like this:
   *    { attrId: 0, status: 0, dataType: 32, attrData: 254 }
   *
   *    attrId is a 16-bit attribute id.
   *    status is an 8-bit status indicating the success/failure of the read.
   *    dataType is an 8-bit field indicating the type of data.
   *    attrData contains the actual data.
   *
   *    The above fields can be examined symbolically using the zcl-id module:
   *    zclId.attr('genLevelCtrl', 0).key == 'currentLevel'
   *    zclId.status(0).key == 'success'
   *    zclId.dataType(32).key == 'uint8'
   *
   * @returns an array containing 2 entries. The first entry is the
   *    property value, and the second entry is a printable version
   *    suitable for logging.
   */

  parseAttrEntry(attrEntry) {
    return this.parseValueFromAttr(attrEntry);
  }

  /**
   * @method parseColorAttr
   *
   * Converts the ZCL 'currentHue' and 'currentSaturation' attributes (uint8's)
   * into an RGB color string.
   */
  parseColorAttr(attrEntries) {
    let hue = 0;
    let sat = 0;
    for (const attrEntry of attrEntries) {
      switch (attrEntry.attrId) {
        case 0:
          hue = attrEntry.attrData;
          break;
        case 1:
          sat = attrEntry.attrData;
          break;
      }
    }
    let level = 0;
    const levelProperty = this.device.findProperty('_level');
    if (levelProperty) {
      level = levelProperty.value;
    }
    const color = new Color({h: hue, s: sat, v: level});
    const colorStr = color.rgb().hex();
    return [colorStr, colorStr];
  }

  /**
   * @method parseLevelAttr
   *
   * Converts the ZCL 'currentLevel' attribute (a uint8) into
   * a 'level' property (a percentage).
   */
  parseLevelAttr(attrEntry) {
    this.level = attrEntry.attrData;
    const percent = levelToPercent(this.level);
    return [
      percent,
      `${percent.toFixed(1)}% (${this.level})`,
    ];
  }

  /**
   * @method parseHaCurrentAttr
   *
   * Converts the rmsCurrent attribute into current (amps)
   * for devices which support the haElectricalMeasurement cluster.
   */
  parseHaCurrentAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_currentMul');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_currentDiv');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let current = 0;
    if (this.multiplier && this.divisor) {
      const rmsCurrent = attrEntry.attrData;
      current = rmsCurrent * this.multiplier / this.divisor;
    }
    return [current, `${current}`];
  }

  /**
   * @method parseHaInstantaneousPowerAttr
   *
   * Converts the instantaneousDemand attribute into power (watts)
   * for devices which support the haElectricalMeasurement cluster.
   */
  parseHaInstantaneousPowerAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_powerMul');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_powerDiv');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let power = 0;
    if (this.multiplier && this.divisor) {
      const demand = attrEntry.attrData;
      // the units for haElectricalMeasurement are watts
      power = demand * this.multiplier / this.divisor;
    }
    return [power, `${power}`];
  }

  /**
   * @method parseSeInstantaneousPowerAttr
   *
   * Converts the instantaneousDemand attribute into power (watts)
   * for devices which support the seMetering cluster.
   */
  parseSeInstantaneousPowerAttr(attrEntry) {
    if (!this.hasOwnProperty('multiplier')) {
      const multiplierProperty = this.device.findProperty('_multiplier');
      if (multiplierProperty && multiplierProperty.value) {
        this.multiplier = multiplierProperty.value;
      }
    }
    if (!this.hasOwnProperty('divisor')) {
      const divisorProperty = this.device.findProperty('_divisor');
      if (divisorProperty && divisorProperty.value) {
        this.divisor = divisorProperty.value;
      }
    }

    let power = 0;
    if (this.multiplier && this.divisor) {
      const demand = attrEntry.attrData;
      // the units for seMetering are kilowatts, so we multiple by 1000
      // to convert to watts.
      power = demand * this.multiplier * 1000 / this.divisor;
    }
    return [power, `${power}`];
  }

  /**
   * @method parseNumericAttr
   *
   * Converts generic numeric attributes in a number.
   */
  parseNumericAttr(attrEntry) {
    const value = attrEntry.attrData;
    return [value, `${value}`];
  }

  /**
   * @method parseOnOffAttr
   *
   * Converts the ZCL 'onOff' attribute (a boolean) into the 'on' property
   * (a boolean).
   */
  parseOnOffAttr(attrEntry) {
    const propertyValue = attrEntry.attrData != 0;
    return [
      propertyValue,
      `${(propertyValue ? 'on' : 'off')} (${attrEntry.attrData})`,
    ];
  }

  /**
   * @method setColorValue
   *
   * Convert the 'color' property value (an RGB hex string) into hue
   * and saturation values.
   */
  setColorValue(propertyValue) {
    const color = new Color(propertyValue);
    const hsv = color.hsv().color;
    const hue = hsv[0];   // 0-359
    const sat = hsv[1];   // 0-100
    const level = hsv[2]; // 0-100

    const levelProperty = this.device.findProperty('_level');
    if (levelProperty) {
      this.device.sendZclFrameWaitExplicitRx(
        levelProperty,
        levelProperty.valueToZclData(level));
    }

    return [
      {
        frameCntl: {frameType: 1},
        cmd: 'moveToHueAndSaturation',
        payload: [Math.round(hue / 360 * 254),
                  Math.round(sat / 100 * 254),
                  10],  // 10ths of a second
      },
      `hsv: [${hue}, ${sat}, ${level}]`,
    ];
  }

  /**
   * @method setLevelValue
   *
   * Convert the 'level' property value (a percentage) into the ZCL
   * 'moveToLevel' command along with a light level.
   */
  setLevelValue(propertyValue) {
    // propertyValue is a percentage 0-100
    if (this.hasOwnProperty('min') && propertyValue < this.min) {
      propertyValue = this.min;
    }
    if (this.hasOwnProperty('max') && propertyValue > this.max) {
      propertyValue = this.max;
    }
    this.level = percentToLevel(propertyValue);
    return [
      {
        frameCntl: {frameType: 1},
        cmd: 'moveToLevel',
        payload: [this.level],
      },
      `level: ${this.level} (${propertyValue.toFixed(1)}%)`,
    ];
  }

  /**
   * @method setOnOffAttr
   *
   * Converts the 'on' property value (a boolean) into the ZCL on or off
   * command.
   */
  setOnOffValue(propertyValue) {
    // propertyValue is a boolean
    const attr = propertyValue ? 'on' : 'off';
    return [
      {
        frameCntl: {frameType: 1},
        cmd: attr,
      },
      attr,
    ];
  }

  /**
   * @returns a promise which resolves to the updated value.
   *
   * @note it is possible that the updated value doesn't match
   * the value passed in.
   */
  setValue(value) {
    if (!this.setAttrFromValue) {
      return Promise.resolve();
    }

    let deferredSet = this.deferredSet;
    if (!deferredSet) {
      deferredSet = new Deferred();
      this.deferredSet = deferredSet;
    }

    this.device.sendZclFrameWaitExplicitRxResolve(
      this, this.valueToZclData(value));
    return deferredSet.promise;
  }

  valueToZclData(value) {
    this.setCachedValue(value);

    const [zclData, logData] = this.setAttrFromValue(value);

    console.log('setProperty property:', this.name,
                'for:', this.device.name,
                'profileId:', utils.hexStr(this.profileId, 4),
                'endpoint:', this.endpoint,
                'clusterId:', utils.hexStr(this.clusterId, 4),
                'zcl:', logData,
                'value:', value);

    return zclData;
  }
}

module.exports = ZigbeeProperty;
