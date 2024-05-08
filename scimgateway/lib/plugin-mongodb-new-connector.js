// =================================================================================
// File:    plugin-mongodb.js
//
// Author:  Qriar Labs
//
// Purpose: Mongo DB user-provisioning
//
// =================================================================================
"use strict";

const Connection = require("tedious").Connection;
const Request = require("tedious").Request;
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// mandatory plugin initialization - start
const path = require("path");
let ScimGateway = require("./scimgateway");
const scimgateway = new ScimGateway();
const pluginName = path.basename(__filename, ".js");
const configDir = path.join(__dirname, "..", "config");
const configFile = path.join(`${configDir}`, `${pluginName}.json`);
let config = require(configFile).endpoint;
config = scimgateway.processExtConfig(pluginName, config); // add any external config process.env and process.file
scimgateway.authPassThroughAllowed = false; // true enables auth passThrough (no scimgateway authentication). scimgateway instead includes ctx (ctx.request.header) in plugin methods. Note, requires plugin-logic for handling/passing ctx.request.header.authorization to be used in endpoint communication
// mandatory plugin initialization - end

const userSchema = prisma[config.connection.userCollectionName];
const groupSchema = prisma[config.connection.groupCollectionName];

// =================================================
// getUsers
// =================================================
scimgateway.getUsers = async (baseEntity, getObj, attributes, ctx) => {
  //
  // "getObj" = { attribute: <>, operator: <>, value: <>, rawFilter: <>, startIndex: <>, count: <> }
  // rawFilter is always included when filtering
  // attribute, operator and value are included when requesting unique object or simpel filtering
  // See comments in the "mandatory if-else logic - start"
  //
  // "attributes" is array of attributes to be returned - if empty, all supported attributes should be returned
  // Should normally return all supported user attributes having id and userName as mandatory
  // id and userName are most often considered as "the same" having value = <UserID>
  // Note, the value of returned 'id' will be used as 'id' in modifyUser and deleteUser
  // scimgateway will automatically filter response according to the attributes list
  //
  const action = "getUsers";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" getObj=${
      getObj ? JSON.stringify(getObj) : ""
    } attributes=${attributes}`
  );

  let filter;

  // mandatory if-else logic - start
  if (getObj.operator) {
    if (
      getObj.operator === "eq" &&
      ["id", "userName", "externalId"].includes(getObj.attribute)
    ) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
      filter = {
        ...(await scimgateway
          .endpointMapper(
            "outbound",
            { userName: getObj.value },
            config.map.user
          )
          .then((res) => res[0])),
      };
    } else if (getObj.operator === "eq" && getObj.attribute === "group.value") {
      // optional - only used when groups are member of users, not default behavior - correspond to getGroupUsers() in versions < 4.x.x
      throw new Error(
        `${action} error: not supporting groups member of user filtering: ${getObj.rawFilter}`
      );
    } else {
      // optional - simpel filtering
      throw new Error(
        `${action} error: not supporting simpel filtering: ${getObj.rawFilter}`
      );
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
    throw new Error(
      `${action} not error: supporting advanced filtering: ${getObj.rawFilter}`
    );
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all users to be returned - correspond to exploreUsers() in versions < 4.x.x
    filter = {};
  }
  // mandatory if-else logic - end

  if (!filter)
    throw new Error(
      `${action} error: mandatory if-else logic not fully implemented`
    );

  try {
    return await new Promise((resolve, reject) => {
      const ret = {
        // itemsPerPage will be set by scimgateway
        Resources: [],
        totalResults: null,
      };

      async function main() {
        const rows = await userSchema.findMany({ where: filter });

        for (const row in rows) {
          const scimUser = await scimgateway
            .endpointMapper("inbound", rows[row], config.map.user)
            .then((res) => res[0]);

          const groups = await groupSchema.findMany({
            where: { members: { has: scimUser.id } },
          });

          const groupsList = await Promise.all(
            groups.map(async (group) => {
              const formattedGroup = await scimgateway
                .endpointMapper("inbound", group, config.map.group)
                .then((res) => res[0]);

              return {
                value: formattedGroup.id,
                display: formattedGroup.displayName,
              };
            })
          );

          scimUser.id = scimUser.userName;
          ret.Resources.push({ ...scimUser, groups: groupsList });
        }
      }

      main()
        .then(async () => {
          resolve(ret); // all explored users
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// createUser
// =================================================
scimgateway.createUser = async (baseEntity, userObj, ctx) => {
  const action = "createUser";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" userObj=${JSON.stringify(
      userObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      let response = null;
      async function main() {
        const newUser = await scimgateway
          .endpointMapper("outbound", userObj, config.map.user)
          .then((res) => res[0]);

        response = await userSchema.create({ data: newUser }).catch((err) => {
          if (err.code === "P2002") {
            throw new Error(`Duplicate key at ${JSON.stringify(err.meta)}`);
          }
          throw new Error(
            `Error at field: ${JSON.stringify(err.meta)}: ${err.message}`
          );
        });
      }

      main()
        .then(async () => {
          resolve(response);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// deleteUser
// =================================================
scimgateway.deleteUser = async (baseEntity, id, ctx) => {
  const action = "deleteUser";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const user = await userSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { userName: id }, config.map.user)
            .then((res) => res[0]),
        });

        if (!user) {
          throw new Error(`User ${id} not found`);
        }

        const groups = await groupSchema.findMany({
          where: { members: { has: user.id } },
        });

        await groups?.forEach(async (group) => {
          await groupSchema.update({
            where: { id: group.id },
            data: { members: group.members.filter((item) => item !== user.id) },
          });
        });

        await userSchema
          .delete({
            where: await scimgateway
              .endpointMapper("outbound", { userName: id }, config.map.user)
              .then((res) => res[0]),
          })
          .catch((err) => {
            if (err.code === "P2025") {
              throw new Error(`User ${id} not found`);
            } else {
              throw new Error(err.message);
            }
          });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// modifyUser
// =================================================
scimgateway.modifyUser = async (baseEntity, id, attrObj, ctx) => {
  const action = "modifyUser";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(
      attrObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const updatedUser = await scimgateway
          .endpointMapper("outbound", attrObj, config.map.user)
          .then((res) => res[0]);

        const user = await userSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { userName: id }, config.map.user)
            .then((res) => res[0]),
        });

        if (user) {
          await userSchema.update({
            where: await scimgateway
              .endpointMapper("outbound", { userName: id }, config.map.user)
              .then((res) => res[0]),
            data: updatedUser,
          });
        } else {
          throw new Error(`User ${id} not found`);
        }
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// getGroups
// =================================================
scimgateway.getGroups = async (baseEntity, getObj, attributes, ctx) => {
  //
  // "getObj" = { attribute: <>, operator: <>, value: <>, rawFilter: <>, startIndex: <>, count: <> }
  // rawFilter is always included when filtering
  // attribute, operator and value are included when requesting unique object or simpel filtering
  // See comments in the "mandatory if-else logic - start"
  //
  // "attributes" is array of attributes to be returned - if empty, all supported attributes should be returned
  // Should normally return all supported group attributes having id, displayName and members as mandatory
  // id and displayName are most often considered as "the same" having value = <GroupName>
  // Note, the value of returned 'id' will be used as 'id' in modifyGroup and deleteGroup
  // scimgateway will automatically filter response according to the attributes list
  //
  const action = "getGroups";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" getObj=${
      getObj ? JSON.stringify(getObj) : ""
    } attributes=${attributes}`
  );

  let filter;
  // mandatory if-else logic - start
  if (getObj.operator) {
    if (
      getObj.operator === "eq" &&
      ["id", "displayName", "externalId"].includes(getObj.attribute)
    ) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
      filter = {
        ...(await scimgateway
          .endpointMapper("outbound", { id: getObj.value }, config.map.group)
          .then((res) => res[0])),
      };
    } else if (
      getObj.operator === "eq" &&
      getObj.attribute === "members.value"
    ) {
      // mandatory - return all groups the user 'id' (getObj.value) is member of - correspond to getGroupMembers() in versions < 4.x.x
      // Resources = [{ id: <id-group>> , displayName: <displayName-group>, members [{value: <id-user>}] }]
    } else {
      // optional - simpel filtering
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all groups to be returned - correspond to exploreGroups() in versions < 4.x.x
  }
  // mandatory if-else logic - end

  try {
    return await new Promise((resolve, reject) => {
      const ret = {
        // itemsPerPage will be set by scimgateway
        Resources: [],
        totalResults: null,
      };

      async function main() {
        const rows = await groupSchema.findMany({ where: filter });

        for (const row in rows) {
          const scimGroup = await scimgateway
            .endpointMapper("inbound", rows[row], config.map.group)
            .then((res) => res[0]);

          const users = await userSchema.findMany({
            where: { id: { in: rows[row].members } },
          });

          const members = await Promise.all(
            users.map(async (user) => {
              const formattedUser = await scimgateway
                .endpointMapper("inbound", user, config.map.user)
                .then((res) => res[0]);

              return {
                value: formattedUser.id,
                display: formattedUser.userName,
              };
            })
          );

          ret.Resources.push({
            ...scimGroup,
            members,
          });
        }
      }

      main()
        .then(async () => {
          resolve(ret); // all explored users
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// createGroup
// =================================================
scimgateway.createGroup = async (baseEntity, groupObj, ctx) => {
  const action = "createGroup";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" groupObj=${JSON.stringify(
      groupObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const newGroup = await scimgateway
          .endpointMapper("outbound", groupObj, config.map.group)
          .then((res) => res[0]);

        await groupSchema
          .create({ data: { ...newGroup, members: [] } })
          .catch((err) => {
            if (err.code === "P2002") {
              throw new Error(`Duplicate key at ${JSON.stringify(err.meta)}`);
            }
            throw new Error(
              `Error at field: ${JSON.stringify(err.meta)}: ${err.message}`
            );
          });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// deleteGroup
// =================================================
scimgateway.deleteGroup = async (baseEntity, id, ctx) => {
  const action = "deleteGroup";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const group = await groupSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { id }, config.map.group)
            .then((res) => res[0]),
        });

        if (!group) {
          throw new Error(`Group ${id} not found`);
        }

        await groupSchema
          .delete({
            where: await scimgateway
              .endpointMapper("outbound", { id }, config.map.group)
              .then((res) => res[0]),
          })
          .catch((err) => {
            if (err.code === "P2025") {
              throw new Error(`Group ${id} not found`);
            } else {
              throw new Error(err.message);
            }
          });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// modifyGroup
// =================================================
scimgateway.modifyGroup = async (baseEntity, id, attrObj, ctx) => {
  const action = "modifyGroup";
  scimgateway.logger.debug(
    `${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(
      attrObj
    )}`
  );

  try {
    return await new Promise((resolve, reject) => {
      async function main() {
        const updatedGroup = await scimgateway
          .endpointMapper("outbound", attrObj, config.map.group)
          .then((res) => res[0]);

        const selectedGroup = await groupSchema.findUnique({
          where: await scimgateway
            .endpointMapper("outbound", { id: id }, config.map.group)
            .then((res) => res[0]),
        });

        if (!selectedGroup) {
          throw new Error(`Group ${id} not found`);
        }

        let newMembers = selectedGroup.members;
        if (attrObj.members?.length) {
          for (const memberIndex in attrObj.members) {
            const member = attrObj.members[memberIndex];

            const userFilter = await scimgateway
              .endpointMapper(
                "outbound",
                { userName: member.value },
                config.map.user
              )
              .then((res) => res[0]);

            const user = await userSchema.findFirst({
              where: userFilter,
            });

            if (!user) {
              throw new Error(`User ${id} not found`);
            }

            if (member.operation === "delete") {
              newMembers = selectedGroup.members.filter(
                (item) => item !== user?.id
              );
            } else {
              if (!newMembers.includes(user?.id)) {
                newMembers.push(user.id);
              } else {
                /* eslint-disable */console.log(...oo_oo(`2694767530_585_16_585_58_4`,"relationship already exists"));
              }
            }
          }
        }

        delete updatedGroup["id"];
        await groupSchema.update({
          where: await scimgateway
            .endpointMapper("outbound", { id }, config.map.group)
            .then((res) => res[0]),
          data: { ...updatedGroup, members: newMembers },
        });
      }

      main()
        .then(async () => {
          resolve(null);
        })
        .catch(async (err) => {
          const e = new Error(err.message);
          return reject(e);
        })
        .finally(async () => {
          await prisma.$disconnect();
        });
    });
  } catch (err) {
    scimgateway.formatError(action, err);
  }
};

// =================================================
// helpers
// =================================================

//
// Cleanup on exit
//
process.on("SIGTERM", () => {
  // kill
});
process.on("SIGINT", () => {
  // Ctrl+C
});
/* istanbul ignore next *//* c8 ignore start *//* eslint-disable */;function oo_cm(){try{return (0,eval)("globalThis._console_ninja") || (0,eval)("/* https://github.com/wallabyjs/console-ninja#how-does-it-work */'use strict';function _0x365e(){var _0x4bf39d=['string','prototype','host','time','_cleanNode','edge','noFunctions','expressionsToEvaluate','cappedElements','cappedProps','Map','toLowerCase','hits','root_exp_id','_sortProps','reload','stringify','_connected','_processTreeNodeResult','NEGATIVE_INFINITY','serialize','now','HTMLAllCollection','eventReceivedCallback','isExpressionToEvaluate','String','parse','elements','pop','getOwnPropertySymbols','sort','_p_length','_undefined','2720244UpBlKY','totalStrLength','bigint','_isMap','_objectToString','constructor','_addObjectProperty','autoExpand','map','_p_','_addProperty','array','_isPrimitiveWrapperType','forEach','gateway.docker.internal','create','includes','depth','_disposeWebsocket','_HTMLAllCollection','getOwnPropertyDescriptor','','\\x20browser','_webSocketErrorDocsLink','_isUndefined','_type','autoExpandMaxDepth','length','...','_propertyName','join','_p_name','env','1347117CIEAOe','NEXT_RUNTIME','name','push','location','unref','props','background:\\x20rgb(30,30,30);\\x20color:\\x20rgb(255,213,92)','_capIfString','trace','_setNodeQueryPath','console','_keyStrRegExp','ws://','symbol','global',[\"localhost\",\"127.0.0.1\",\"example.cypress.io\",\"wagner-HP-250-G8-Notebook-PC\",\"192.168.1.22\",\"172.19.0.1\",\"172.17.0.1\",\"172.18.0.1\"],'method','Console\\x20Ninja\\x20failed\\x20to\\x20send\\x20logs,\\x20restarting\\x20the\\x20process\\x20may\\x20help;\\x20also\\x20see\\x20','getter','_getOwnPropertyNames','_setNodePermissions','Symbol','logger\\x20failed\\x20to\\x20connect\\x20to\\x20host,\\x20see\\x20','_addFunctionsNode','disabledTrace','unshift','angular','call','match','path','negativeInfinity','toString','node','onerror','_getOwnPropertyDescriptor','_setNodeExpressionPath','then','type','_allowedToSend',\"/home/wagner/.vscode/extensions/wallabyjs.console-ninja-1.0.319/node_modules\",'_inBrowser','_connecting','default','_isArray','8ouvLXB','catch','1224180sOGDCe','timeStamp','7715344PpwOWQ','send','bind','getOwnPropertyNames','isArray','_allowedToConnectOnSend','count','versions','function','_dateToString','_quotedRegExp','test','_hasMapOnItsPath','autoExpandPreviousObjects','args','getWebSocketClass','url','setter','%c\\x20Console\\x20Ninja\\x20extension\\x20is\\x20connected\\x20to\\x20','_inNextEdge','ws/index.js','current','slice','_treeNodePropertiesAfterFullValue','Set','hrtime','nan','rootExpression','date','hostname','_maxConnectAttemptCount','_hasSymbolPropertyOnItsPath','_reconnectTimeout','_consoleNinjaAllowedToStart','root_exp','stack','_property','_addLoadNode','_socket','2056248VFuTwg','4PMVWEB','next.js','allStrLength','substr','Console\\x20Ninja\\x20failed\\x20to\\x20send\\x20logs,\\x20refreshing\\x20the\\x20page\\x20may\\x20help;\\x20also\\x20see\\x20','value','next.js','_console_ninja_session','replace','sortProps','log','Boolean','index','failed\\x20to\\x20connect\\x20to\\x20host:\\x20','get','see\\x20https://tinyurl.com/2vt8jxzw\\x20for\\x20more\\x20info.','object','readyState','_console_ninja','dockerizedApp','34805','strLength','level','Number','_isSet','_connectToHostNow','__es'+'Module','127.0.0.1','data','_ws','WebSocket','process','remix','origin','defineProperty','onclose','RegExp','_getOwnPropertySymbols','_isNegativeZero','_WebSocket','elapsed','concat','_setNodeLabel','number','_isPrimitiveType','nodeModules','port','hasOwnProperty','_WebSocketClass','warn','enumerable','_treeNodePropertiesBeforeFullValue','[object\\x20Array]','[object\\x20Date]','_setNodeExpandableState','stackTraceLimit','675336sBDjYm','performance','logger\\x20websocket\\x20error','_additionalMetadata','846100UBcSAx','parent','reduceLimits','failed\\x20to\\x20find\\x20and\\x20load\\x20WebSocket','undefined','_setNodeId','toUpperCase','error','onopen','_blacklistedProperty','Buffer','9PzUUaM','astro','expId','_Symbol','null','POSITIVE_INFINITY','resolveGetters','valueOf','nuxt','_regExpToString','unknown','_connectAttemptCount','_attemptToReconnectShortly','capped','charAt','onmessage','autoExpandPropertyCount','Error','getPrototypeOf','message','autoExpandLimit'];_0x365e=function(){return _0x4bf39d;};return _0x365e();}var _0x100f6d=_0x155a;(function(_0x4c1a78,_0x25a126){var _0xd26415=_0x155a,_0x50e0bb=_0x4c1a78();while(!![]){try{var _0x469aa5=parseInt(_0xd26415(0xb0))/0x1+-parseInt(_0xd26415(0x16e))/0x2+parseInt(_0xd26415(0x116))/0x3*(parseInt(_0xd26415(0x16f))/0x4)+-parseInt(_0xd26415(0xb4))/0x5+-parseInt(_0xd26415(0xf5))/0x6+parseInt(_0xd26415(0x147))/0x7*(parseInt(_0xd26415(0x143))/0x8)+parseInt(_0xd26415(0xbf))/0x9*(parseInt(_0xd26415(0x145))/0xa);if(_0x469aa5===_0x25a126)break;else _0x50e0bb['push'](_0x50e0bb['shift']());}catch(_0x40944b){_0x50e0bb['push'](_0x50e0bb['shift']());}}}(_0x365e,0xaa79b));var K=Object[_0x100f6d(0x104)],Q=Object[_0x100f6d(0x9a)],G=Object[_0x100f6d(0x109)],ee=Object[_0x100f6d(0x14a)],te=Object[_0x100f6d(0xd1)],ne=Object['prototype'][_0x100f6d(0xa7)],re=(_0x198510,_0x2cdd5a,_0x16e136,_0x50097e)=>{var _0x51ea1f=_0x100f6d;if(_0x2cdd5a&&typeof _0x2cdd5a==_0x51ea1f(0x17f)||typeof _0x2cdd5a==_0x51ea1f(0x14f)){for(let _0x418882 of ee(_0x2cdd5a))!ne[_0x51ea1f(0x132)](_0x198510,_0x418882)&&_0x418882!==_0x16e136&&Q(_0x198510,_0x418882,{'get':()=>_0x2cdd5a[_0x418882],'enumerable':!(_0x50097e=G(_0x2cdd5a,_0x418882))||_0x50097e[_0x51ea1f(0xaa)]});}return _0x198510;},V=(_0x4d02e6,_0x490e33,_0x5f0bb0)=>(_0x5f0bb0=_0x4d02e6!=null?K(te(_0x4d02e6)):{},re(_0x490e33||!_0x4d02e6||!_0x4d02e6[_0x100f6d(0x92)]?Q(_0x5f0bb0,_0x100f6d(0x141),{'value':_0x4d02e6,'enumerable':!0x0}):_0x5f0bb0,_0x4d02e6)),x=class{constructor(_0x6a213b,_0x3f575b,_0x12ba3c,_0x5c68fe,_0x383db1,_0x1625d7){var _0x37d4ad=_0x100f6d;this['global']=_0x6a213b,this[_0x37d4ad(0xd6)]=_0x3f575b,this[_0x37d4ad(0xa6)]=_0x12ba3c,this[_0x37d4ad(0xa5)]=_0x5c68fe,this['dockerizedApp']=_0x383db1,this[_0x37d4ad(0xeb)]=_0x1625d7,this[_0x37d4ad(0x13d)]=!0x0,this[_0x37d4ad(0x14c)]=!0x0,this[_0x37d4ad(0xe5)]=!0x1,this[_0x37d4ad(0x140)]=!0x1,this['_inNextEdge']=_0x6a213b['process']?.[_0x37d4ad(0x115)]?.[_0x37d4ad(0x117)]===_0x37d4ad(0xd9),this[_0x37d4ad(0x13f)]=!this[_0x37d4ad(0x125)][_0x37d4ad(0x97)]?.[_0x37d4ad(0x14e)]?.[_0x37d4ad(0x137)]&&!this['_inNextEdge'],this[_0x37d4ad(0xa8)]=null,this[_0x37d4ad(0xca)]=0x0,this[_0x37d4ad(0x165)]=0x14,this[_0x37d4ad(0x10c)]='https://tinyurl.com/37x8b79t',this['_sendErrorMessage']=(this[_0x37d4ad(0x13f)]?_0x37d4ad(0x173):_0x37d4ad(0x128))+this['_webSocketErrorDocsLink'];}async[_0x100f6d(0x156)](){var _0x561c2c=_0x100f6d;if(this['_WebSocketClass'])return this[_0x561c2c(0xa8)];let _0xaae01d;if(this[_0x561c2c(0x13f)]||this[_0x561c2c(0x15a)])_0xaae01d=this[_0x561c2c(0x125)][_0x561c2c(0x96)];else{if(this[_0x561c2c(0x125)][_0x561c2c(0x97)]?.[_0x561c2c(0x9f)])_0xaae01d=this[_0x561c2c(0x125)][_0x561c2c(0x97)]?.['_WebSocket'];else try{let _0x164440=await import('path');_0xaae01d=(await import((await import(_0x561c2c(0x157)))['pathToFileURL'](_0x164440[_0x561c2c(0x113)](this[_0x561c2c(0xa5)],_0x561c2c(0x15b)))[_0x561c2c(0x136)]()))[_0x561c2c(0x141)];}catch{try{_0xaae01d=require(require(_0x561c2c(0x134))[_0x561c2c(0x113)](this[_0x561c2c(0xa5)],'ws'));}catch{throw new Error(_0x561c2c(0xb7));}}}return this[_0x561c2c(0xa8)]=_0xaae01d,_0xaae01d;}[_0x100f6d(0x91)](){var _0x1f439d=_0x100f6d;this[_0x1f439d(0x140)]||this[_0x1f439d(0xe5)]||this[_0x1f439d(0xca)]>=this[_0x1f439d(0x165)]||(this[_0x1f439d(0x14c)]=!0x1,this[_0x1f439d(0x140)]=!0x0,this[_0x1f439d(0xca)]++,this[_0x1f439d(0x95)]=new Promise((_0x220021,_0x1e9b53)=>{var _0xa77801=_0x1f439d;this[_0xa77801(0x156)]()[_0xa77801(0x13b)](_0x3e9084=>{var _0x3e4f8d=_0xa77801;let _0x3d8052=new _0x3e9084(_0x3e4f8d(0x123)+(!this[_0x3e4f8d(0x13f)]&&this[_0x3e4f8d(0x182)]?_0x3e4f8d(0x103):this['host'])+':'+this[_0x3e4f8d(0xa6)]);_0x3d8052[_0x3e4f8d(0x138)]=()=>{var _0x5b7a7b=_0x3e4f8d;this[_0x5b7a7b(0x13d)]=!0x1,this[_0x5b7a7b(0x107)](_0x3d8052),this[_0x5b7a7b(0xcb)](),_0x1e9b53(new Error(_0x5b7a7b(0xb2)));},_0x3d8052[_0x3e4f8d(0xbc)]=()=>{var _0x15e03c=_0x3e4f8d;this[_0x15e03c(0x13f)]||_0x3d8052[_0x15e03c(0x16d)]&&_0x3d8052[_0x15e03c(0x16d)][_0x15e03c(0x11b)]&&_0x3d8052['_socket'][_0x15e03c(0x11b)](),_0x220021(_0x3d8052);},_0x3d8052[_0x3e4f8d(0x9b)]=()=>{var _0x1b0436=_0x3e4f8d;this[_0x1b0436(0x14c)]=!0x0,this[_0x1b0436(0x107)](_0x3d8052),this['_attemptToReconnectShortly']();},_0x3d8052[_0x3e4f8d(0xce)]=_0x10d7ff=>{var _0x3c647=_0x3e4f8d;try{if(!_0x10d7ff?.[_0x3c647(0x94)]||!this[_0x3c647(0xeb)])return;let _0x1863e9=JSON[_0x3c647(0xee)](_0x10d7ff[_0x3c647(0x94)]);this[_0x3c647(0xeb)](_0x1863e9[_0x3c647(0x127)],_0x1863e9[_0x3c647(0x155)],this[_0x3c647(0x125)],this[_0x3c647(0x13f)]);}catch{}};})[_0xa77801(0x13b)](_0x5580da=>(this[_0xa77801(0xe5)]=!0x0,this[_0xa77801(0x140)]=!0x1,this[_0xa77801(0x14c)]=!0x1,this['_allowedToSend']=!0x0,this['_connectAttemptCount']=0x0,_0x5580da))['catch'](_0x49b9e0=>(this[_0xa77801(0xe5)]=!0x1,this[_0xa77801(0x140)]=!0x1,console[_0xa77801(0xa9)](_0xa77801(0x12d)+this[_0xa77801(0x10c)]),_0x1e9b53(new Error(_0xa77801(0x17c)+(_0x49b9e0&&_0x49b9e0[_0xa77801(0xd2)])))));}));}[_0x100f6d(0x107)](_0x25e179){var _0x897618=_0x100f6d;this[_0x897618(0xe5)]=!0x1,this[_0x897618(0x140)]=!0x1;try{_0x25e179[_0x897618(0x9b)]=null,_0x25e179[_0x897618(0x138)]=null,_0x25e179[_0x897618(0xbc)]=null;}catch{}try{_0x25e179[_0x897618(0x180)]<0x2&&_0x25e179['close']();}catch{}}[_0x100f6d(0xcb)](){var _0x45be83=_0x100f6d;clearTimeout(this[_0x45be83(0x167)]),!(this['_connectAttemptCount']>=this[_0x45be83(0x165)])&&(this[_0x45be83(0x167)]=setTimeout(()=>{var _0x49c943=_0x45be83;this[_0x49c943(0xe5)]||this[_0x49c943(0x140)]||(this[_0x49c943(0x91)](),this[_0x49c943(0x95)]?.[_0x49c943(0x144)](()=>this[_0x49c943(0xcb)]()));},0x1f4),this[_0x45be83(0x167)][_0x45be83(0x11b)]&&this[_0x45be83(0x167)]['unref']());}async[_0x100f6d(0x148)](_0x241334){var _0xd68d06=_0x100f6d;try{if(!this[_0xd68d06(0x13d)])return;this[_0xd68d06(0x14c)]&&this['_connectToHostNow'](),(await this[_0xd68d06(0x95)])['send'](JSON[_0xd68d06(0xe4)](_0x241334));}catch(_0x6782f5){console[_0xd68d06(0xa9)](this['_sendErrorMessage']+':\\x20'+(_0x6782f5&&_0x6782f5[_0xd68d06(0xd2)])),this[_0xd68d06(0x13d)]=!0x1,this[_0xd68d06(0xcb)]();}}};function q(_0x183290,_0x53ae0e,_0x340eb6,_0x289b85,_0x1c49e6,_0x304813,_0x453dc3,_0x8b6b03=ie){var _0x40b5f8=_0x100f6d;let _0x58f8f5=_0x340eb6['split'](',')[_0x40b5f8(0xfd)](_0x18b072=>{var _0x514bf7=_0x40b5f8;try{if(!_0x183290[_0x514bf7(0x176)]){let _0x2b79d5=_0x183290[_0x514bf7(0x97)]?.['versions']?.['node']||_0x183290[_0x514bf7(0x97)]?.[_0x514bf7(0x115)]?.['NEXT_RUNTIME']===_0x514bf7(0xd9);(_0x1c49e6==='next.js'||_0x1c49e6===_0x514bf7(0x98)||_0x1c49e6===_0x514bf7(0xc0)||_0x1c49e6===_0x514bf7(0x131))&&(_0x1c49e6+=_0x2b79d5?'\\x20server':_0x514bf7(0x10b)),_0x183290['_console_ninja_session']={'id':+new Date(),'tool':_0x1c49e6},_0x453dc3&&_0x1c49e6&&!_0x2b79d5&&console[_0x514bf7(0x179)](_0x514bf7(0x159)+(_0x1c49e6[_0x514bf7(0xcd)](0x0)[_0x514bf7(0xba)]()+_0x1c49e6['substr'](0x1))+',',_0x514bf7(0x11d),_0x514bf7(0x17e));}let _0x53e98b=new x(_0x183290,_0x53ae0e,_0x18b072,_0x289b85,_0x304813,_0x8b6b03);return _0x53e98b[_0x514bf7(0x148)][_0x514bf7(0x149)](_0x53e98b);}catch(_0x4015c2){return console[_0x514bf7(0xa9)]('logger\\x20failed\\x20to\\x20connect\\x20to\\x20host',_0x4015c2&&_0x4015c2[_0x514bf7(0xd2)]),()=>{};}});return _0x8c765d=>_0x58f8f5[_0x40b5f8(0x102)](_0x329c84=>_0x329c84(_0x8c765d));}function _0x155a(_0x518b61,_0xfe3351){var _0x365e29=_0x365e();return _0x155a=function(_0x155a7b,_0x5d995b){_0x155a7b=_0x155a7b-0x91;var _0x4e9788=_0x365e29[_0x155a7b];return _0x4e9788;},_0x155a(_0x518b61,_0xfe3351);}function ie(_0x38a7c5,_0x801dfc,_0x572cb0,_0x2d40f7){var _0x761c3c=_0x100f6d;_0x2d40f7&&_0x38a7c5==='reload'&&_0x572cb0['location'][_0x761c3c(0xe3)]();}function b(_0x5a7875){var _0x856aa3=_0x100f6d;let _0x186dbc=function(_0x43c61b,_0x57edde){return _0x57edde-_0x43c61b;},_0x19630d;if(_0x5a7875[_0x856aa3(0xb1)])_0x19630d=function(){var _0xf6a5c=_0x856aa3;return _0x5a7875[_0xf6a5c(0xb1)][_0xf6a5c(0xe9)]();};else{if(_0x5a7875[_0x856aa3(0x97)]&&_0x5a7875[_0x856aa3(0x97)][_0x856aa3(0x160)]&&_0x5a7875[_0x856aa3(0x97)]?.[_0x856aa3(0x115)]?.[_0x856aa3(0x117)]!==_0x856aa3(0xd9))_0x19630d=function(){var _0x130c45=_0x856aa3;return _0x5a7875[_0x130c45(0x97)][_0x130c45(0x160)]();},_0x186dbc=function(_0xe76613,_0x6b2ba2){return 0x3e8*(_0x6b2ba2[0x0]-_0xe76613[0x0])+(_0x6b2ba2[0x1]-_0xe76613[0x1])/0xf4240;};else try{let {performance:_0x1ef89c}=require('perf_hooks');_0x19630d=function(){return _0x1ef89c['now']();};}catch{_0x19630d=function(){return+new Date();};}}return{'elapsed':_0x186dbc,'timeStamp':_0x19630d,'now':()=>Date[_0x856aa3(0xe9)]()};}function X(_0x540dce,_0x308400,_0x197cd6){var _0xa72c45=_0x100f6d;if(_0x540dce[_0xa72c45(0x168)]!==void 0x0)return _0x540dce[_0xa72c45(0x168)];let _0x21ad4e=_0x540dce['process']?.[_0xa72c45(0x14e)]?.[_0xa72c45(0x137)]||_0x540dce['process']?.[_0xa72c45(0x115)]?.[_0xa72c45(0x117)]==='edge';return _0x21ad4e&&_0x197cd6===_0xa72c45(0xc7)?_0x540dce[_0xa72c45(0x168)]=!0x1:_0x540dce[_0xa72c45(0x168)]=_0x21ad4e||!_0x308400||_0x540dce['location']?.[_0xa72c45(0x164)]&&_0x308400[_0xa72c45(0x105)](_0x540dce[_0xa72c45(0x11a)][_0xa72c45(0x164)]),_0x540dce[_0xa72c45(0x168)];}function H(_0xfe2af0,_0x388b73,_0x1bc0bf,_0x3acc10){var _0x235281=_0x100f6d;_0xfe2af0=_0xfe2af0,_0x388b73=_0x388b73,_0x1bc0bf=_0x1bc0bf,_0x3acc10=_0x3acc10;let _0x123366=b(_0xfe2af0),_0x25c041=_0x123366[_0x235281(0xa0)],_0x148f6d=_0x123366['timeStamp'];class _0x5d28d0{constructor(){var _0xb60e07=_0x235281;this[_0xb60e07(0x122)]=/^(?!(?:do|if|in|for|let|new|try|var|case|else|enum|eval|false|null|this|true|void|with|break|catch|class|const|super|throw|while|yield|delete|export|import|public|return|static|switch|typeof|default|extends|finally|package|private|continue|debugger|function|arguments|interface|protected|implements|instanceof)$)[_$a-zA-Z\\xA0-\\uFFFF][_$a-zA-Z0-9\\xA0-\\uFFFF]*$/,this['_numberRegExp']=/^(0|[1-9][0-9]*)$/,this[_0xb60e07(0x151)]=/'([^\\\\']|\\\\')*'/,this[_0xb60e07(0xf4)]=_0xfe2af0[_0xb60e07(0xb8)],this[_0xb60e07(0x108)]=_0xfe2af0[_0xb60e07(0xea)],this[_0xb60e07(0x139)]=Object[_0xb60e07(0x109)],this[_0xb60e07(0x12a)]=Object[_0xb60e07(0x14a)],this[_0xb60e07(0xc2)]=_0xfe2af0[_0xb60e07(0x12c)],this[_0xb60e07(0xc8)]=RegExp['prototype'][_0xb60e07(0x136)],this['_dateToString']=Date['prototype'][_0xb60e07(0x136)];}[_0x235281(0xe8)](_0x4bfe05,_0x15c27b,_0x3557fb,_0x3bfe0f){var _0x305edb=_0x235281,_0x27a89e=this,_0x583a58=_0x3557fb[_0x305edb(0xfc)];function _0xdd8490(_0x396596,_0x27bbd3,_0x2cd14d){var _0x487c3f=_0x305edb;_0x27bbd3['type']=_0x487c3f(0xc9),_0x27bbd3['error']=_0x396596[_0x487c3f(0xd2)],_0x1356b0=_0x2cd14d[_0x487c3f(0x137)][_0x487c3f(0x15c)],_0x2cd14d['node']['current']=_0x27bbd3,_0x27a89e[_0x487c3f(0xab)](_0x27bbd3,_0x2cd14d);}try{_0x3557fb[_0x305edb(0x185)]++,_0x3557fb['autoExpand']&&_0x3557fb[_0x305edb(0x154)][_0x305edb(0x119)](_0x15c27b);var _0x1d77d5,_0x5c864a,_0x2bd91a,_0x36d01f,_0x21a841=[],_0x577716=[],_0x23c905,_0x31abcc=this[_0x305edb(0x10e)](_0x15c27b),_0x192046=_0x31abcc===_0x305edb(0x100),_0xe3790d=!0x1,_0x5cb826=_0x31abcc===_0x305edb(0x14f),_0x94feea=this[_0x305edb(0xa4)](_0x31abcc),_0x38aca9=this[_0x305edb(0x101)](_0x31abcc),_0xd9634a=_0x94feea||_0x38aca9,_0x4116b8={},_0x44c132=0x0,_0x4993d6=!0x1,_0x1356b0,_0x38cdaf=/^(([1-9]{1}[0-9]*)|0)$/;if(_0x3557fb[_0x305edb(0x106)]){if(_0x192046){if(_0x5c864a=_0x15c27b['length'],_0x5c864a>_0x3557fb[_0x305edb(0xef)]){for(_0x2bd91a=0x0,_0x36d01f=_0x3557fb[_0x305edb(0xef)],_0x1d77d5=_0x2bd91a;_0x1d77d5<_0x36d01f;_0x1d77d5++)_0x577716[_0x305edb(0x119)](_0x27a89e[_0x305edb(0xff)](_0x21a841,_0x15c27b,_0x31abcc,_0x1d77d5,_0x3557fb));_0x4bfe05[_0x305edb(0xdc)]=!0x0;}else{for(_0x2bd91a=0x0,_0x36d01f=_0x5c864a,_0x1d77d5=_0x2bd91a;_0x1d77d5<_0x36d01f;_0x1d77d5++)_0x577716[_0x305edb(0x119)](_0x27a89e['_addProperty'](_0x21a841,_0x15c27b,_0x31abcc,_0x1d77d5,_0x3557fb));}_0x3557fb[_0x305edb(0xcf)]+=_0x577716[_0x305edb(0x110)];}if(!(_0x31abcc===_0x305edb(0xc3)||_0x31abcc===_0x305edb(0xb8))&&!_0x94feea&&_0x31abcc!=='String'&&_0x31abcc!==_0x305edb(0xbe)&&_0x31abcc!==_0x305edb(0xf7)){var _0x1b55d9=_0x3bfe0f[_0x305edb(0x11c)]||_0x3557fb[_0x305edb(0x11c)];if(this[_0x305edb(0x187)](_0x15c27b)?(_0x1d77d5=0x0,_0x15c27b['forEach'](function(_0x1c2373){var _0x2fe734=_0x305edb;if(_0x44c132++,_0x3557fb['autoExpandPropertyCount']++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;return;}if(!_0x3557fb[_0x2fe734(0xec)]&&_0x3557fb[_0x2fe734(0xfc)]&&_0x3557fb[_0x2fe734(0xcf)]>_0x3557fb[_0x2fe734(0xd3)]){_0x4993d6=!0x0;return;}_0x577716[_0x2fe734(0x119)](_0x27a89e[_0x2fe734(0xff)](_0x21a841,_0x15c27b,'Set',_0x1d77d5++,_0x3557fb,function(_0x57bfde){return function(){return _0x57bfde;};}(_0x1c2373)));})):this[_0x305edb(0xf8)](_0x15c27b)&&_0x15c27b[_0x305edb(0x102)](function(_0x15a97e,_0x35effb){var _0x5d15fd=_0x305edb;if(_0x44c132++,_0x3557fb[_0x5d15fd(0xcf)]++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;return;}if(!_0x3557fb[_0x5d15fd(0xec)]&&_0x3557fb['autoExpand']&&_0x3557fb[_0x5d15fd(0xcf)]>_0x3557fb[_0x5d15fd(0xd3)]){_0x4993d6=!0x0;return;}var _0x487fe2=_0x35effb[_0x5d15fd(0x136)]();_0x487fe2['length']>0x64&&(_0x487fe2=_0x487fe2[_0x5d15fd(0x15d)](0x0,0x64)+_0x5d15fd(0x111)),_0x577716[_0x5d15fd(0x119)](_0x27a89e[_0x5d15fd(0xff)](_0x21a841,_0x15c27b,_0x5d15fd(0xde),_0x487fe2,_0x3557fb,function(_0x5bb66c){return function(){return _0x5bb66c;};}(_0x15a97e)));}),!_0xe3790d){try{for(_0x23c905 in _0x15c27b)if(!(_0x192046&&_0x38cdaf[_0x305edb(0x152)](_0x23c905))&&!this[_0x305edb(0xbd)](_0x15c27b,_0x23c905,_0x3557fb)){if(_0x44c132++,_0x3557fb[_0x305edb(0xcf)]++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;break;}if(!_0x3557fb['isExpressionToEvaluate']&&_0x3557fb['autoExpand']&&_0x3557fb['autoExpandPropertyCount']>_0x3557fb[_0x305edb(0xd3)]){_0x4993d6=!0x0;break;}_0x577716['push'](_0x27a89e[_0x305edb(0xfb)](_0x21a841,_0x4116b8,_0x15c27b,_0x31abcc,_0x23c905,_0x3557fb));}}catch{}if(_0x4116b8[_0x305edb(0xf3)]=!0x0,_0x5cb826&&(_0x4116b8[_0x305edb(0x114)]=!0x0),!_0x4993d6){var _0x1f24ca=[][_0x305edb(0xa1)](this[_0x305edb(0x12a)](_0x15c27b))[_0x305edb(0xa1)](this['_getOwnPropertySymbols'](_0x15c27b));for(_0x1d77d5=0x0,_0x5c864a=_0x1f24ca[_0x305edb(0x110)];_0x1d77d5<_0x5c864a;_0x1d77d5++)if(_0x23c905=_0x1f24ca[_0x1d77d5],!(_0x192046&&_0x38cdaf[_0x305edb(0x152)](_0x23c905['toString']()))&&!this['_blacklistedProperty'](_0x15c27b,_0x23c905,_0x3557fb)&&!_0x4116b8['_p_'+_0x23c905['toString']()]){if(_0x44c132++,_0x3557fb['autoExpandPropertyCount']++,_0x44c132>_0x1b55d9){_0x4993d6=!0x0;break;}if(!_0x3557fb[_0x305edb(0xec)]&&_0x3557fb[_0x305edb(0xfc)]&&_0x3557fb[_0x305edb(0xcf)]>_0x3557fb[_0x305edb(0xd3)]){_0x4993d6=!0x0;break;}_0x577716[_0x305edb(0x119)](_0x27a89e['_addObjectProperty'](_0x21a841,_0x4116b8,_0x15c27b,_0x31abcc,_0x23c905,_0x3557fb));}}}}}if(_0x4bfe05[_0x305edb(0x13c)]=_0x31abcc,_0xd9634a?(_0x4bfe05[_0x305edb(0x174)]=_0x15c27b[_0x305edb(0xc6)](),this[_0x305edb(0x11e)](_0x31abcc,_0x4bfe05,_0x3557fb,_0x3bfe0f)):_0x31abcc===_0x305edb(0x163)?_0x4bfe05['value']=this[_0x305edb(0x150)][_0x305edb(0x132)](_0x15c27b):_0x31abcc===_0x305edb(0xf7)?_0x4bfe05[_0x305edb(0x174)]=_0x15c27b['toString']():_0x31abcc===_0x305edb(0x9c)?_0x4bfe05[_0x305edb(0x174)]=this[_0x305edb(0xc8)]['call'](_0x15c27b):_0x31abcc==='symbol'&&this[_0x305edb(0xc2)]?_0x4bfe05[_0x305edb(0x174)]=this['_Symbol'][_0x305edb(0xd5)][_0x305edb(0x136)][_0x305edb(0x132)](_0x15c27b):!_0x3557fb[_0x305edb(0x106)]&&!(_0x31abcc==='null'||_0x31abcc===_0x305edb(0xb8))&&(delete _0x4bfe05['value'],_0x4bfe05[_0x305edb(0xcc)]=!0x0),_0x4993d6&&(_0x4bfe05[_0x305edb(0xdd)]=!0x0),_0x1356b0=_0x3557fb[_0x305edb(0x137)][_0x305edb(0x15c)],_0x3557fb[_0x305edb(0x137)][_0x305edb(0x15c)]=_0x4bfe05,this[_0x305edb(0xab)](_0x4bfe05,_0x3557fb),_0x577716[_0x305edb(0x110)]){for(_0x1d77d5=0x0,_0x5c864a=_0x577716['length'];_0x1d77d5<_0x5c864a;_0x1d77d5++)_0x577716[_0x1d77d5](_0x1d77d5);}_0x21a841[_0x305edb(0x110)]&&(_0x4bfe05[_0x305edb(0x11c)]=_0x21a841);}catch(_0x3c98a5){_0xdd8490(_0x3c98a5,_0x4bfe05,_0x3557fb);}return this[_0x305edb(0xb3)](_0x15c27b,_0x4bfe05),this['_treeNodePropertiesAfterFullValue'](_0x4bfe05,_0x3557fb),_0x3557fb[_0x305edb(0x137)]['current']=_0x1356b0,_0x3557fb[_0x305edb(0x185)]--,_0x3557fb[_0x305edb(0xfc)]=_0x583a58,_0x3557fb[_0x305edb(0xfc)]&&_0x3557fb[_0x305edb(0x154)][_0x305edb(0xf0)](),_0x4bfe05;}[_0x235281(0x9d)](_0x4866a4){var _0x13f9e4=_0x235281;return Object['getOwnPropertySymbols']?Object[_0x13f9e4(0xf1)](_0x4866a4):[];}['_isSet'](_0x44ab9f){var _0x5d3774=_0x235281;return!!(_0x44ab9f&&_0xfe2af0[_0x5d3774(0x15f)]&&this[_0x5d3774(0xf9)](_0x44ab9f)==='[object\\x20Set]'&&_0x44ab9f[_0x5d3774(0x102)]);}[_0x235281(0xbd)](_0x3c1fcb,_0x14d3de,_0xe3ccd2){var _0x431ec6=_0x235281;return _0xe3ccd2[_0x431ec6(0xda)]?typeof _0x3c1fcb[_0x14d3de]=='function':!0x1;}[_0x235281(0x10e)](_0x473b03){var _0x944e15=_0x235281,_0x5c50d1='';return _0x5c50d1=typeof _0x473b03,_0x5c50d1===_0x944e15(0x17f)?this[_0x944e15(0xf9)](_0x473b03)===_0x944e15(0xac)?_0x5c50d1='array':this[_0x944e15(0xf9)](_0x473b03)===_0x944e15(0xad)?_0x5c50d1=_0x944e15(0x163):this['_objectToString'](_0x473b03)==='[object\\x20BigInt]'?_0x5c50d1=_0x944e15(0xf7):_0x473b03===null?_0x5c50d1=_0x944e15(0xc3):_0x473b03[_0x944e15(0xfa)]&&(_0x5c50d1=_0x473b03['constructor']['name']||_0x5c50d1):_0x5c50d1===_0x944e15(0xb8)&&this['_HTMLAllCollection']&&_0x473b03 instanceof this[_0x944e15(0x108)]&&(_0x5c50d1=_0x944e15(0xea)),_0x5c50d1;}[_0x235281(0xf9)](_0x486eb6){var _0x57a287=_0x235281;return Object[_0x57a287(0xd5)][_0x57a287(0x136)][_0x57a287(0x132)](_0x486eb6);}[_0x235281(0xa4)](_0x36a4db){var _0x2260d5=_0x235281;return _0x36a4db==='boolean'||_0x36a4db===_0x2260d5(0xd4)||_0x36a4db==='number';}[_0x235281(0x101)](_0x50d2d5){var _0x33eacc=_0x235281;return _0x50d2d5===_0x33eacc(0x17a)||_0x50d2d5===_0x33eacc(0xed)||_0x50d2d5===_0x33eacc(0x186);}[_0x235281(0xff)](_0xebc9f4,_0x132b3b,_0x5ee102,_0x40a48b,_0x4d3397,_0x294111){var _0x32cc24=this;return function(_0x2f9972){var _0x2b984c=_0x155a,_0x534f66=_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0x15c)],_0x18b783=_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0x17b)],_0x5e926c=_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0xb5)];_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0xb5)]=_0x534f66,_0x4d3397[_0x2b984c(0x137)]['index']=typeof _0x40a48b=='number'?_0x40a48b:_0x2f9972,_0xebc9f4['push'](_0x32cc24['_property'](_0x132b3b,_0x5ee102,_0x40a48b,_0x4d3397,_0x294111)),_0x4d3397['node'][_0x2b984c(0xb5)]=_0x5e926c,_0x4d3397[_0x2b984c(0x137)][_0x2b984c(0x17b)]=_0x18b783;};}[_0x235281(0xfb)](_0x32df2e,_0x12a1e5,_0xc71809,_0x2d65ad,_0x42fa86,_0x437c12,_0x25d0d3){var _0x25b497=_0x235281,_0x49aec9=this;return _0x12a1e5[_0x25b497(0xfe)+_0x42fa86[_0x25b497(0x136)]()]=!0x0,function(_0x50e2a2){var _0x226bfb=_0x25b497,_0x5cd4ee=_0x437c12[_0x226bfb(0x137)][_0x226bfb(0x15c)],_0x14874d=_0x437c12[_0x226bfb(0x137)][_0x226bfb(0x17b)],_0x18230a=_0x437c12[_0x226bfb(0x137)]['parent'];_0x437c12[_0x226bfb(0x137)]['parent']=_0x5cd4ee,_0x437c12[_0x226bfb(0x137)][_0x226bfb(0x17b)]=_0x50e2a2,_0x32df2e['push'](_0x49aec9[_0x226bfb(0x16b)](_0xc71809,_0x2d65ad,_0x42fa86,_0x437c12,_0x25d0d3)),_0x437c12['node']['parent']=_0x18230a,_0x437c12['node'][_0x226bfb(0x17b)]=_0x14874d;};}[_0x235281(0x16b)](_0x5626ac,_0x50561d,_0x9da97,_0x4c58e5,_0x23116e){var _0x48a85b=_0x235281,_0x389759=this;_0x23116e||(_0x23116e=function(_0x123050,_0x5656c1){return _0x123050[_0x5656c1];});var _0x48c665=_0x9da97[_0x48a85b(0x136)](),_0x389227=_0x4c58e5[_0x48a85b(0xdb)]||{},_0x1aef1d=_0x4c58e5[_0x48a85b(0x106)],_0x3a10f3=_0x4c58e5['isExpressionToEvaluate'];try{var _0xb2b982=this[_0x48a85b(0xf8)](_0x5626ac),_0x3af70e=_0x48c665;_0xb2b982&&_0x3af70e[0x0]==='\\x27'&&(_0x3af70e=_0x3af70e[_0x48a85b(0x172)](0x1,_0x3af70e['length']-0x2));var _0x54947c=_0x4c58e5[_0x48a85b(0xdb)]=_0x389227['_p_'+_0x3af70e];_0x54947c&&(_0x4c58e5[_0x48a85b(0x106)]=_0x4c58e5[_0x48a85b(0x106)]+0x1),_0x4c58e5[_0x48a85b(0xec)]=!!_0x54947c;var _0x512501=typeof _0x9da97==_0x48a85b(0x124),_0x495834={'name':_0x512501||_0xb2b982?_0x48c665:this[_0x48a85b(0x112)](_0x48c665)};if(_0x512501&&(_0x495834['symbol']=!0x0),!(_0x50561d===_0x48a85b(0x100)||_0x50561d===_0x48a85b(0xd0))){var _0xfa734f=this[_0x48a85b(0x139)](_0x5626ac,_0x9da97);if(_0xfa734f&&(_0xfa734f['set']&&(_0x495834[_0x48a85b(0x158)]=!0x0),_0xfa734f[_0x48a85b(0x17d)]&&!_0x54947c&&!_0x4c58e5['resolveGetters']))return _0x495834[_0x48a85b(0x129)]=!0x0,this[_0x48a85b(0xe6)](_0x495834,_0x4c58e5),_0x495834;}var _0x5c1e1e;try{_0x5c1e1e=_0x23116e(_0x5626ac,_0x9da97);}catch(_0x29d816){return _0x495834={'name':_0x48c665,'type':_0x48a85b(0xc9),'error':_0x29d816['message']},this[_0x48a85b(0xe6)](_0x495834,_0x4c58e5),_0x495834;}var _0x3f929c=this[_0x48a85b(0x10e)](_0x5c1e1e),_0x4d41cc=this[_0x48a85b(0xa4)](_0x3f929c);if(_0x495834['type']=_0x3f929c,_0x4d41cc)this['_processTreeNodeResult'](_0x495834,_0x4c58e5,_0x5c1e1e,function(){var _0xf57c2d=_0x48a85b;_0x495834[_0xf57c2d(0x174)]=_0x5c1e1e[_0xf57c2d(0xc6)](),!_0x54947c&&_0x389759[_0xf57c2d(0x11e)](_0x3f929c,_0x495834,_0x4c58e5,{});});else{var _0x476f73=_0x4c58e5[_0x48a85b(0xfc)]&&_0x4c58e5[_0x48a85b(0x185)]<_0x4c58e5[_0x48a85b(0x10f)]&&_0x4c58e5[_0x48a85b(0x154)]['indexOf'](_0x5c1e1e)<0x0&&_0x3f929c!==_0x48a85b(0x14f)&&_0x4c58e5[_0x48a85b(0xcf)]<_0x4c58e5['autoExpandLimit'];_0x476f73||_0x4c58e5[_0x48a85b(0x185)]<_0x1aef1d||_0x54947c?(this['serialize'](_0x495834,_0x5c1e1e,_0x4c58e5,_0x54947c||{}),this['_additionalMetadata'](_0x5c1e1e,_0x495834)):this[_0x48a85b(0xe6)](_0x495834,_0x4c58e5,_0x5c1e1e,function(){var _0x133397=_0x48a85b;_0x3f929c===_0x133397(0xc3)||_0x3f929c===_0x133397(0xb8)||(delete _0x495834[_0x133397(0x174)],_0x495834[_0x133397(0xcc)]=!0x0);});}return _0x495834;}finally{_0x4c58e5[_0x48a85b(0xdb)]=_0x389227,_0x4c58e5[_0x48a85b(0x106)]=_0x1aef1d,_0x4c58e5[_0x48a85b(0xec)]=_0x3a10f3;}}[_0x235281(0x11e)](_0x5b1211,_0x59fc92,_0x83c6c5,_0x5255c9){var _0xfa7425=_0x235281,_0x51875f=_0x5255c9[_0xfa7425(0x184)]||_0x83c6c5['strLength'];if((_0x5b1211===_0xfa7425(0xd4)||_0x5b1211===_0xfa7425(0xed))&&_0x59fc92['value']){let _0x512aa1=_0x59fc92[_0xfa7425(0x174)][_0xfa7425(0x110)];_0x83c6c5[_0xfa7425(0x171)]+=_0x512aa1,_0x83c6c5[_0xfa7425(0x171)]>_0x83c6c5[_0xfa7425(0xf6)]?(_0x59fc92['capped']='',delete _0x59fc92['value']):_0x512aa1>_0x51875f&&(_0x59fc92['capped']=_0x59fc92['value'][_0xfa7425(0x172)](0x0,_0x51875f),delete _0x59fc92[_0xfa7425(0x174)]);}}[_0x235281(0xf8)](_0x436501){var _0x14778e=_0x235281;return!!(_0x436501&&_0xfe2af0[_0x14778e(0xde)]&&this[_0x14778e(0xf9)](_0x436501)==='[object\\x20Map]'&&_0x436501[_0x14778e(0x102)]);}[_0x235281(0x112)](_0x30d2ac){var _0x5927be=_0x235281;if(_0x30d2ac[_0x5927be(0x133)](/^\\d+$/))return _0x30d2ac;var _0x565201;try{_0x565201=JSON[_0x5927be(0xe4)](''+_0x30d2ac);}catch{_0x565201='\\x22'+this['_objectToString'](_0x30d2ac)+'\\x22';}return _0x565201[_0x5927be(0x133)](/^\"([a-zA-Z_][a-zA-Z_0-9]*)\"$/)?_0x565201=_0x565201['substr'](0x1,_0x565201[_0x5927be(0x110)]-0x2):_0x565201=_0x565201[_0x5927be(0x177)](/'/g,'\\x5c\\x27')['replace'](/\\\\\"/g,'\\x22')[_0x5927be(0x177)](/(^\"|\"$)/g,'\\x27'),_0x565201;}[_0x235281(0xe6)](_0x4a2717,_0x230a88,_0x2de502,_0x4e513c){var _0x564575=_0x235281;this['_treeNodePropertiesBeforeFullValue'](_0x4a2717,_0x230a88),_0x4e513c&&_0x4e513c(),this[_0x564575(0xb3)](_0x2de502,_0x4a2717),this[_0x564575(0x15e)](_0x4a2717,_0x230a88);}[_0x235281(0xab)](_0x3d3783,_0x37d5aa){var _0x38655d=_0x235281;this['_setNodeId'](_0x3d3783,_0x37d5aa),this[_0x38655d(0x120)](_0x3d3783,_0x37d5aa),this['_setNodeExpressionPath'](_0x3d3783,_0x37d5aa),this[_0x38655d(0x12b)](_0x3d3783,_0x37d5aa);}[_0x235281(0xb9)](_0x2df325,_0x4bc486){}[_0x235281(0x120)](_0x48453a,_0x332dfe){}[_0x235281(0xa2)](_0x4bd450,_0x4b2266){}[_0x235281(0x10d)](_0x45ea9d){return _0x45ea9d===this['_undefined'];}[_0x235281(0x15e)](_0x2c883c,_0x1a3d5b){var _0x243d5b=_0x235281;this[_0x243d5b(0xa2)](_0x2c883c,_0x1a3d5b),this[_0x243d5b(0xae)](_0x2c883c),_0x1a3d5b[_0x243d5b(0x178)]&&this[_0x243d5b(0xe2)](_0x2c883c),this[_0x243d5b(0x12e)](_0x2c883c,_0x1a3d5b),this[_0x243d5b(0x16c)](_0x2c883c,_0x1a3d5b),this['_cleanNode'](_0x2c883c);}[_0x235281(0xb3)](_0x2f6249,_0x45422e){var _0x4d9aee=_0x235281;let _0x1a2c7c;try{_0xfe2af0[_0x4d9aee(0x121)]&&(_0x1a2c7c=_0xfe2af0[_0x4d9aee(0x121)][_0x4d9aee(0xbb)],_0xfe2af0['console'][_0x4d9aee(0xbb)]=function(){}),_0x2f6249&&typeof _0x2f6249[_0x4d9aee(0x110)]==_0x4d9aee(0xa3)&&(_0x45422e[_0x4d9aee(0x110)]=_0x2f6249[_0x4d9aee(0x110)]);}catch{}finally{_0x1a2c7c&&(_0xfe2af0[_0x4d9aee(0x121)][_0x4d9aee(0xbb)]=_0x1a2c7c);}if(_0x45422e[_0x4d9aee(0x13c)]===_0x4d9aee(0xa3)||_0x45422e['type']===_0x4d9aee(0x186)){if(isNaN(_0x45422e[_0x4d9aee(0x174)]))_0x45422e[_0x4d9aee(0x161)]=!0x0,delete _0x45422e[_0x4d9aee(0x174)];else switch(_0x45422e[_0x4d9aee(0x174)]){case Number[_0x4d9aee(0xc4)]:_0x45422e['positiveInfinity']=!0x0,delete _0x45422e[_0x4d9aee(0x174)];break;case Number[_0x4d9aee(0xe7)]:_0x45422e[_0x4d9aee(0x135)]=!0x0,delete _0x45422e['value'];break;case 0x0:this[_0x4d9aee(0x9e)](_0x45422e[_0x4d9aee(0x174)])&&(_0x45422e['negativeZero']=!0x0);break;}}else _0x45422e[_0x4d9aee(0x13c)]==='function'&&typeof _0x2f6249['name']==_0x4d9aee(0xd4)&&_0x2f6249[_0x4d9aee(0x118)]&&_0x45422e['name']&&_0x2f6249['name']!==_0x45422e[_0x4d9aee(0x118)]&&(_0x45422e['funcName']=_0x2f6249[_0x4d9aee(0x118)]);}[_0x235281(0x9e)](_0x1ca5a4){var _0x538372=_0x235281;return 0x1/_0x1ca5a4===Number[_0x538372(0xe7)];}[_0x235281(0xe2)](_0x1811e2){var _0x37cee4=_0x235281;!_0x1811e2['props']||!_0x1811e2['props'][_0x37cee4(0x110)]||_0x1811e2[_0x37cee4(0x13c)]===_0x37cee4(0x100)||_0x1811e2['type']===_0x37cee4(0xde)||_0x1811e2[_0x37cee4(0x13c)]===_0x37cee4(0x15f)||_0x1811e2[_0x37cee4(0x11c)][_0x37cee4(0xf2)](function(_0x54ca10,_0x3f3975){var _0x3c7d33=_0x37cee4,_0x5e8ecc=_0x54ca10[_0x3c7d33(0x118)]['toLowerCase'](),_0x5f2945=_0x3f3975[_0x3c7d33(0x118)][_0x3c7d33(0xdf)]();return _0x5e8ecc<_0x5f2945?-0x1:_0x5e8ecc>_0x5f2945?0x1:0x0;});}['_addFunctionsNode'](_0x9187c3,_0x356d54){var _0x5d379f=_0x235281;if(!(_0x356d54[_0x5d379f(0xda)]||!_0x9187c3[_0x5d379f(0x11c)]||!_0x9187c3['props']['length'])){for(var _0xc242a3=[],_0x444b5e=[],_0x4dabf6=0x0,_0x504f43=_0x9187c3['props'][_0x5d379f(0x110)];_0x4dabf6<_0x504f43;_0x4dabf6++){var _0x23475b=_0x9187c3[_0x5d379f(0x11c)][_0x4dabf6];_0x23475b[_0x5d379f(0x13c)]==='function'?_0xc242a3[_0x5d379f(0x119)](_0x23475b):_0x444b5e[_0x5d379f(0x119)](_0x23475b);}if(!(!_0x444b5e[_0x5d379f(0x110)]||_0xc242a3[_0x5d379f(0x110)]<=0x1)){_0x9187c3[_0x5d379f(0x11c)]=_0x444b5e;var _0x54046a={'functionsNode':!0x0,'props':_0xc242a3};this[_0x5d379f(0xb9)](_0x54046a,_0x356d54),this[_0x5d379f(0xa2)](_0x54046a,_0x356d54),this[_0x5d379f(0xae)](_0x54046a),this['_setNodePermissions'](_0x54046a,_0x356d54),_0x54046a['id']+='\\x20f',_0x9187c3[_0x5d379f(0x11c)][_0x5d379f(0x130)](_0x54046a);}}}[_0x235281(0x16c)](_0x54d0ce,_0x2d9605){}[_0x235281(0xae)](_0x34f6e4){}[_0x235281(0x142)](_0x3ea577){var _0x1d5fe9=_0x235281;return Array[_0x1d5fe9(0x14b)](_0x3ea577)||typeof _0x3ea577==_0x1d5fe9(0x17f)&&this[_0x1d5fe9(0xf9)](_0x3ea577)===_0x1d5fe9(0xac);}[_0x235281(0x12b)](_0x8d9769,_0x5b5ce7){}[_0x235281(0xd8)](_0x10eb81){var _0x39f088=_0x235281;delete _0x10eb81[_0x39f088(0x166)],delete _0x10eb81['_hasSetOnItsPath'],delete _0x10eb81[_0x39f088(0x153)];}[_0x235281(0x13a)](_0x289e64,_0x10cc15){}}let _0x15deba=new _0x5d28d0(),_0x152369={'props':0x64,'elements':0x64,'strLength':0x400*0x32,'totalStrLength':0x400*0x32,'autoExpandLimit':0x1388,'autoExpandMaxDepth':0xa},_0x4dfd3f={'props':0x5,'elements':0x5,'strLength':0x100,'totalStrLength':0x100*0x3,'autoExpandLimit':0x1e,'autoExpandMaxDepth':0x2};function _0x138560(_0x2f3fcb,_0x18c1e8,_0x532f85,_0x6fafaf,_0x12aeb8,_0x3fcc97){var _0xe648fe=_0x235281;let _0x55e646,_0x26210e;try{_0x26210e=_0x148f6d(),_0x55e646=_0x1bc0bf[_0x18c1e8],!_0x55e646||_0x26210e-_0x55e646['ts']>0x1f4&&_0x55e646['count']&&_0x55e646['time']/_0x55e646[_0xe648fe(0x14d)]<0x64?(_0x1bc0bf[_0x18c1e8]=_0x55e646={'count':0x0,'time':0x0,'ts':_0x26210e},_0x1bc0bf[_0xe648fe(0xe0)]={}):_0x26210e-_0x1bc0bf[_0xe648fe(0xe0)]['ts']>0x32&&_0x1bc0bf[_0xe648fe(0xe0)]['count']&&_0x1bc0bf['hits'][_0xe648fe(0xd7)]/_0x1bc0bf['hits'][_0xe648fe(0x14d)]<0x64&&(_0x1bc0bf[_0xe648fe(0xe0)]={});let _0x154ff5=[],_0x2e3311=_0x55e646[_0xe648fe(0xb6)]||_0x1bc0bf[_0xe648fe(0xe0)][_0xe648fe(0xb6)]?_0x4dfd3f:_0x152369,_0x3c2e92=_0x72f00e=>{var _0xece30=_0xe648fe;let _0x1135de={};return _0x1135de[_0xece30(0x11c)]=_0x72f00e[_0xece30(0x11c)],_0x1135de[_0xece30(0xef)]=_0x72f00e['elements'],_0x1135de[_0xece30(0x184)]=_0x72f00e['strLength'],_0x1135de[_0xece30(0xf6)]=_0x72f00e['totalStrLength'],_0x1135de['autoExpandLimit']=_0x72f00e[_0xece30(0xd3)],_0x1135de[_0xece30(0x10f)]=_0x72f00e[_0xece30(0x10f)],_0x1135de['sortProps']=!0x1,_0x1135de[_0xece30(0xda)]=!_0x388b73,_0x1135de['depth']=0x1,_0x1135de[_0xece30(0x185)]=0x0,_0x1135de[_0xece30(0xc1)]=_0xece30(0xe1),_0x1135de[_0xece30(0x162)]=_0xece30(0x169),_0x1135de[_0xece30(0xfc)]=!0x0,_0x1135de['autoExpandPreviousObjects']=[],_0x1135de[_0xece30(0xcf)]=0x0,_0x1135de[_0xece30(0xc5)]=!0x0,_0x1135de[_0xece30(0x171)]=0x0,_0x1135de[_0xece30(0x137)]={'current':void 0x0,'parent':void 0x0,'index':0x0},_0x1135de;};for(var _0x1e7497=0x0;_0x1e7497<_0x12aeb8['length'];_0x1e7497++)_0x154ff5[_0xe648fe(0x119)](_0x15deba[_0xe648fe(0xe8)]({'timeNode':_0x2f3fcb===_0xe648fe(0xd7)||void 0x0},_0x12aeb8[_0x1e7497],_0x3c2e92(_0x2e3311),{}));if(_0x2f3fcb===_0xe648fe(0x11f)){let _0x33ed06=Error['stackTraceLimit'];try{Error[_0xe648fe(0xaf)]=0x1/0x0,_0x154ff5[_0xe648fe(0x119)](_0x15deba[_0xe648fe(0xe8)]({'stackNode':!0x0},new Error()[_0xe648fe(0x16a)],_0x3c2e92(_0x2e3311),{'strLength':0x1/0x0}));}finally{Error['stackTraceLimit']=_0x33ed06;}}return{'method':_0xe648fe(0x179),'version':_0x3acc10,'args':[{'ts':_0x532f85,'session':_0x6fafaf,'args':_0x154ff5,'id':_0x18c1e8,'context':_0x3fcc97}]};}catch(_0x199939){return{'method':'log','version':_0x3acc10,'args':[{'ts':_0x532f85,'session':_0x6fafaf,'args':[{'type':_0xe648fe(0xc9),'error':_0x199939&&_0x199939['message']}],'id':_0x18c1e8,'context':_0x3fcc97}]};}finally{try{if(_0x55e646&&_0x26210e){let _0xe44928=_0x148f6d();_0x55e646[_0xe648fe(0x14d)]++,_0x55e646[_0xe648fe(0xd7)]+=_0x25c041(_0x26210e,_0xe44928),_0x55e646['ts']=_0xe44928,_0x1bc0bf[_0xe648fe(0xe0)][_0xe648fe(0x14d)]++,_0x1bc0bf['hits'][_0xe648fe(0xd7)]+=_0x25c041(_0x26210e,_0xe44928),_0x1bc0bf[_0xe648fe(0xe0)]['ts']=_0xe44928,(_0x55e646[_0xe648fe(0x14d)]>0x32||_0x55e646['time']>0x64)&&(_0x55e646[_0xe648fe(0xb6)]=!0x0),(_0x1bc0bf[_0xe648fe(0xe0)][_0xe648fe(0x14d)]>0x3e8||_0x1bc0bf['hits'][_0xe648fe(0xd7)]>0x12c)&&(_0x1bc0bf['hits']['reduceLimits']=!0x0);}}catch{}}}return _0x138560;}((_0x424913,_0x5f1dd1,_0x4f7b0c,_0x32c73f,_0x36c922,_0x3c8ea9,_0x41de49,_0x3a3377,_0x1b7b05,_0x164082,_0x41202b)=>{var _0x142ec4=_0x100f6d;if(_0x424913[_0x142ec4(0x181)])return _0x424913['_console_ninja'];if(!X(_0x424913,_0x3a3377,_0x36c922))return _0x424913[_0x142ec4(0x181)]={'consoleLog':()=>{},'consoleTrace':()=>{},'consoleTime':()=>{},'consoleTimeEnd':()=>{},'autoLog':()=>{},'autoLogMany':()=>{},'autoTraceMany':()=>{},'coverage':()=>{},'autoTrace':()=>{},'autoTime':()=>{},'autoTimeEnd':()=>{}},_0x424913[_0x142ec4(0x181)];let _0x3b2c7c=b(_0x424913),_0x4b8e24=_0x3b2c7c['elapsed'],_0x438d72=_0x3b2c7c[_0x142ec4(0x146)],_0x3a7ca6=_0x3b2c7c[_0x142ec4(0xe9)],_0x413926={'hits':{},'ts':{}},_0x506b15=H(_0x424913,_0x1b7b05,_0x413926,_0x3c8ea9),_0x468cb3=_0x6b2fb9=>{_0x413926['ts'][_0x6b2fb9]=_0x438d72();},_0x56fc34=(_0x3a84a9,_0x58a4ac)=>{var _0x1d0756=_0x142ec4;let _0x266417=_0x413926['ts'][_0x58a4ac];if(delete _0x413926['ts'][_0x58a4ac],_0x266417){let _0x16f46c=_0x4b8e24(_0x266417,_0x438d72());_0x493cf4(_0x506b15(_0x1d0756(0xd7),_0x3a84a9,_0x3a7ca6(),_0x2d06aa,[_0x16f46c],_0x58a4ac));}},_0x279b60=_0x526d53=>(_0x36c922===_0x142ec4(0x170)&&_0x424913['origin']&&_0x526d53?.['args']?.[_0x142ec4(0x110)]&&(_0x526d53['args'][0x0][_0x142ec4(0x99)]=_0x424913[_0x142ec4(0x99)]),_0x526d53);_0x424913[_0x142ec4(0x181)]={'consoleLog':(_0x1127ad,_0x388b26)=>{var _0x4f28fe=_0x142ec4;_0x424913[_0x4f28fe(0x121)][_0x4f28fe(0x179)][_0x4f28fe(0x118)]!=='disabledLog'&&_0x493cf4(_0x506b15(_0x4f28fe(0x179),_0x1127ad,_0x3a7ca6(),_0x2d06aa,_0x388b26));},'consoleTrace':(_0x4664d1,_0x327162)=>{var _0x26ef2c=_0x142ec4;_0x424913[_0x26ef2c(0x121)][_0x26ef2c(0x179)][_0x26ef2c(0x118)]!==_0x26ef2c(0x12f)&&_0x493cf4(_0x279b60(_0x506b15(_0x26ef2c(0x11f),_0x4664d1,_0x3a7ca6(),_0x2d06aa,_0x327162)));},'consoleTime':_0x56d9a6=>{_0x468cb3(_0x56d9a6);},'consoleTimeEnd':(_0x170de0,_0x360af0)=>{_0x56fc34(_0x360af0,_0x170de0);},'autoLog':(_0x384a5e,_0xf744a4)=>{var _0x5b45b1=_0x142ec4;_0x493cf4(_0x506b15(_0x5b45b1(0x179),_0xf744a4,_0x3a7ca6(),_0x2d06aa,[_0x384a5e]));},'autoLogMany':(_0x499ed0,_0x128742)=>{var _0x2755c7=_0x142ec4;_0x493cf4(_0x506b15(_0x2755c7(0x179),_0x499ed0,_0x3a7ca6(),_0x2d06aa,_0x128742));},'autoTrace':(_0x29cd32,_0x44208b)=>{var _0x60f0c9=_0x142ec4;_0x493cf4(_0x279b60(_0x506b15(_0x60f0c9(0x11f),_0x44208b,_0x3a7ca6(),_0x2d06aa,[_0x29cd32])));},'autoTraceMany':(_0x3a4709,_0x3b6ffe)=>{var _0x2b7603=_0x142ec4;_0x493cf4(_0x279b60(_0x506b15(_0x2b7603(0x11f),_0x3a4709,_0x3a7ca6(),_0x2d06aa,_0x3b6ffe)));},'autoTime':(_0x50c84b,_0x5d4759,_0x4b7e0f)=>{_0x468cb3(_0x4b7e0f);},'autoTimeEnd':(_0x124726,_0x5a49f2,_0xdf3f90)=>{_0x56fc34(_0x5a49f2,_0xdf3f90);},'coverage':_0x4f1a20=>{_0x493cf4({'method':'coverage','version':_0x3c8ea9,'args':[{'id':_0x4f1a20}]});}};let _0x493cf4=q(_0x424913,_0x5f1dd1,_0x4f7b0c,_0x32c73f,_0x36c922,_0x164082,_0x41202b),_0x2d06aa=_0x424913[_0x142ec4(0x176)];return _0x424913[_0x142ec4(0x181)];})(globalThis,_0x100f6d(0x93),_0x100f6d(0x183),_0x100f6d(0x13e),_0x100f6d(0x175),'1.0.0','1715180529239',_0x100f6d(0x126),_0x100f6d(0x10a),'','1');");}catch(e){}};/* istanbul ignore next */function oo_oo(i,...v){try{oo_cm().consoleLog(i, v);}catch(e){} return v};/* istanbul ignore next */function oo_tr(i,...v){try{oo_cm().consoleTrace(i, v);}catch(e){} return v};/* istanbul ignore next */function oo_ts(v){try{oo_cm().consoleTime(v);}catch(e){} return v;};/* istanbul ignore next */function oo_te(v, i){try{oo_cm().consoleTimeEnd(v, i);}catch(e){} return v;};/*eslint unicorn/no-abusive-eslint-disable:,eslint-comments/disable-enable-pair:,eslint-comments/no-unlimited-disable:,eslint-comments/no-aggregating-enable:,eslint-comments/no-duplicate-disable:,eslint-comments/no-unused-disable:,eslint-comments/no-unused-enable:,*/