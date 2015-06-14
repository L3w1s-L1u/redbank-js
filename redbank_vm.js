/*******************************************************************************
 * 
 * Virtual Machine
 * 
 ******************************************************************************/

var Format = require('./redbank_format.js');

// var HORIZONTAL_LINE = "=================================================";

var ADDR_LOCAL = 'local';
var ADDR_PARAM = 'param';
var ADDR_LEXICAL = 'lexical';

/**
 * Hash function (FNV-1a 32bit)
 * 
 * @param str
 * @returns
 */
function HASH(str) {
  // gist code : https://gist.github.com/vaiorabbit/5657561
  // 32 bit FNV-1a hash
  // Ref.: http://isthe.com/chongo/tech/comp/fnv/

  var FNV1_32A_INIT = 0x811c9dc5;
  var hval = FNV1_32A_INIT;
  for (var i = 0; i < str.length; ++i) {
    hval ^= str.charCodeAt(i);
    hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8)
        + (hval << 24);
  }
  return hval >>> 0;
}

function HASHMORE(hash, id) {
  // naive implementation
  return (hash * id) >>> 0;
}

function RedbankVM() {

  this.PC = 0;
  this.FP = 0;

  this.PCStack = [];
  this.FPStack = [];

  this.Stack = [];
  this.Objects = [];

  // string hash table
  this.StringHash = [];
  // property hash table
  this.PropertyHash = [];

  // bytecode array
  this.code = {};
  // testcase
  this.testcase = {};
}

/**
 * Retrieve object by id
 * 
 * @param id
 * @returns
 */
RedbankVM.prototype.getObject = function(id) {

  return this.Objects[id];
};

RedbankVM.prototype.typeOfObject = function(id) {

  return this.Objects[id].type;
};

/**
 * add object to array and return id
 * 
 * @param obj
 * @returns {Number}
 */
RedbankVM.prototype.register = function(obj) {

  if (obj.type === undefined) {
    throw "error";
  }

  this.Objects.push(obj);
  var id = this.Objects.length - 1;
  obj.id = id; // back annotation
  return id;
};

/**
 * 
 * remove object out of array
 * 
 * @param id
 */
RedbankVM.prototype.unregister = function(id) {

  this.Objects[id] = undefined;
};

/**
 * may be problematic, examine it! TODO
 * 
 * @param child
 * @param parent
 * @returns
 */
RedbankVM.prototype.isa = function(child, parent) {

  if (typeof child !== 'number' || typeof parent !== 'number') {
    throw "wrong input";
  }

  if (child === 0) {
    return false;
  }

  if (this.Objects[child].PROTOTYPE === parent) {
    return true;
  }

  child = this.Objects[child].PROTOTYPE;
  return this.isa(child, parent);
};

RedbankVM.prototype.internFindString = function(string) {

  var hash = HASH(string);

  hash = hash >>> 20; // drop 20 bits, 12 bit left
  var id = this.StringHash[hash];

  if (id === undefined) {
    return;
  }

  for (; id !== undefined; id = this.getObject(id).nextInSlot) {
    var obj = this.Objects[id];

    if (obj.type !== 'string') {
      throw "not a string";
    }

    if (obj.value === string) {
      return id;
    }
  }
};

RedbankVM.prototype.internNewString = function(id) {

  var obj = this.getObject(id);

  var str = obj.value;

  var hash = HASH(str);
  obj.interned = true;
  obj.hash = hash;

  hash = hash >>> 20; // drop 20 bits, 12 bit left

  obj.nextInSlot = this.StringHash[hash];
  this.StringHash[hash] = id;
};

/**
 * 
 * This function increment the reference count of object id
 * 
 * The object/name/index is pushed into object id's referrer queue, for
 * debugging purpose.
 * 
 * @param id
 * @param object
 * @param name
 * @param index
 */
RedbankVM.prototype.incrREF = function(id, object, name, index) {

  if (object === undefined) {
    throw "error";
  }

  if (id === 0) {
    return;
  }

  var obj = this.getObject(id);

  // for early stage debugging
  if (typeof obj.REF !== 'object' || typeof obj.REF.referrer !== 'object'
      || Array.isArray(obj.REF.referrer) !== true) {
    throw "error";
  }

  obj.REF.count++;
  obj.REF.referrer.push({
    object : object,
    name : name,
    index : index
  });
};

/**
 * 
 * 
 * @param id
 * @param object
 * @param name
 * @param index
 */
RedbankVM.prototype.decrREF = function(id, object, name, index) {

  var i;
  var obj = this.getObject(id);
  if (obj === undefined || obj.REF.referrer.length === 0) {
    throw "error";
  }

  for (i = 0; i < obj.REF.referrer.length; i++) {
    if (index === undefined) {
      if (obj.REF.referrer[i].object === object
          && obj.REF.referrer[i].name === name) {
        break;
      }
    }
    else {
      if (obj.REF.referrer[i].object === object
          && obj.REF.referrer[i].name === name
          && obj.REF.referrer[i].index === index) {
        break;
      }
    }
  }

  if (i === obj.REF.referrer.length) {
    throw "error, referrer not found";
  }

  obj.REF.referrer.splice(i, 1);
  obj.REF.count--;

  if (obj.ref === 0) {

    switch (obj.type) {
    case 'addr':
      break;
    case 'boolean':
      break;
    case 'number':
      break;

    case 'function':
      for (i = 0; i < obj.lexicals.length; i++) {
        this.decrREF(obj.lexicals[i].index);
        // function property TODO
      }
      break;

    case 'link':
      this.decrREF(obj.target);
      break;

    case 'object':
      // TODO recycle object properties
      break;

    default:
      throw "not implemented.";
    }

    this.unregister(id);
  }
};

RedbankVM.prototype.createAddr = function(addrType, index) {

  var addr = {
    type : 'addr',
    REF : {
      count : 0,
      referrer : [],
    },

    addrType : addrType,
    index : index,
  };
  var id = this.register(addr);
  return id;
};

RedbankVM.prototype.createLink = function(target) {

  var link = {

    type : 'link',

    REF : {
      count : 0,
      referrer : [],
    },

    target : 0,
  };
  var id = this.register(link);
  this.set(target, id, 'target');
  return id;
};

/** not used yet * */
RedbankVM.prototype.createLexical = function(size) {

  var lexical = {

    type : 'lexical',

    REF : {
      count : 0,
      referrer : [],
    },

    size : size,
    slots : []
  };

  for (var i = 0; i < size; i++) {
    lexical.slots[i] = 0;
  }

  return this.register(lexical);
};

RedbankVM.prototype.install = function(sid, name, tid) {

  var source = this.getObject(sid);
  var old = 0;

  if (source[name] !== 0) {
    old = source[name];
    source[name] = 0;
  }

  source[name] = tid;
  if (tid !== 0) {
    this.incrREF(tid, sid, name);
  }

  if (old !== 0) {
    this.decrREF(old, sid, name);
  }
};

RedbankVM.prototype.set = function(id, object, name, index) {

  var old = 0;
  var source = this.getObject(object);

  if (source[name] === undefined) {
    throw "error";
  }

  if (index !== undefined) {
    // index must be number and source[name] must be array
    if (typeof index !== 'number' || Array.isArray(source[name]) !== true) {
      throw "error";
    }

    if (source[name][index] !== 0) { // preserve a copy
      old = source[name][index];
      source[name][index] = 0;
    }
    source[name][index] = id;
  }
  else {

    if (source[name] !== 0) { // preserve a copy
      old = source[name];
      source[name] = 0;
    }
    source[name] = id;
  }

  if (id !== 0) {
    this.incrREF(id, object, name, index);
  }

  if (old !== 0) {
    this.decrREF(old, object, name, index);
  }

};

RedbankVM.prototype.createProperty = function(parent, child, name, w, e, c) {

  var property = {

    type : 'property',

    child : 0,
    name : 0,
    nextInObject : 0,
    nextInSlot : 0,

    REF : {
      count : 0,
      referrer : []
    },

    // parent is only used for information purpose
    // when looking up in property hash table
    parent : parent,

    writable : (w === true) ? true : false,
    enumerable : (e === true) ? true : false,
    configurable : (c === true) ? true : false,
  };

  var id = this.register(property);

  this.install(id, 'name', name);
  this.install(id, 'child', child);

  // property hash
  var hash = HASHMORE(name.hash, parent);
  hash = hash >>> 20;
  property.nextInSlot = this.PropertyHash[hash];
  this.PropertyHash[hash] = id;
  this.incrREF(id);

  // install
  var obj = this.getObject(parent);
  property.nextInObject = obj.property;
  obj.property = id;
  this.incrREF(id);

  return id;
};

/**
 * Create a primitive Javascript value object
 * 
 * If the value is a string, it is automatically interned.
 * 
 * @param value
 * @param tag
 * @param builtin
 * @returns
 */
RedbankVM.prototype.createPrimitive = function(value, tag, builtin) {

  var id;

  // check if value is js primitive
  if (!(value === null || // ECMAScript bug according to MDN
  typeof value === 'string' || typeof value === 'number'
      || typeof value === 'boolean' || typeof value === 'undefined')) {
    throw "value is NOT primitive";
  }

  // string intern
  if (typeof value === 'string') {
    id = this.internFindString(value);
    if (id !== undefined) {
      return id;
    }
  }

  // null, string, number, boolean, undefined
  var primitive = {
    type : typeof value,
    REF : {
      count : 0,
      referrer : [],
    },

    isPrimitive : true,
    value : value,
    tag : tag,

  };
  id = this.register(primitive, builtin);

  // string intern
  if (typeof value === 'string') {
    this.internNewString(id);
  }

  return id;
};

RedbankVM.prototype.createObject = function(proto, tag) {

  var obj, id;

  if (typeof proto !== 'number') {
    throw "Use object id as prototype of object";
  }

  obj = {

    type : 'object',

    PROTOTYPE : 0,
    property : 0,

    REF : {
      count : 0,
      referrer : [],
    },

    isPrimitive : false,
    tag : tag,

    /*
     * don't confuse these methods with Object's methods, which should be a
     * property mapped to (native) function object. these methods may be used to
     * implement them.
     */
    toBoolean : function() {
      return true;
    },
    toNumber : function() {
      return 0;
    },
    toString : function() {
      return '[' + this.type + ']';
    },
    valueOf : function() {
      return this;
    }
  };
  id = this.register(obj);
  this.install(id, 'PROTOTYPE', proto);

  // Functions have prototype objects.
  if (this.FUNCTION !== undefined && this.FUNCTION.proto !== undefined
      && this.isa(id, this.FUNCTION.proto)) {
    obj.type = 'function';
    var pid = this.createObject(this.OBJECT.proto);
    this.setPropertyByLiteral(id, pid, 'prototype', true, false, false);
  }

  // // Arrays have length.
  // if (this.isa(obj, this.ARRAY)) {
  // obj.length = 0;
  // obj.toString = function() {
  // var strs = [];
  // for (var i = 0; i < this.length; i++) {
  // strs[i] = this.properties[i].toString();
  // }
  // return strs.join(',');
  // };
  // };

  return id;
};

RedbankVM.prototype.createFunction = function(label, lexnum, length) {

  if (this.FUNCTION.proto === undefined || this.FUNCTION.proto === null) {
    throw "FUNCTION.prototype not initialized.";
  }

  var id = this.createObject(this.FUNCTION.proto);
  var obj = this.Objects[id];
  obj.label = label;
  obj.lexicals = [];
  obj.lexnum = lexnum;

  for (var i = 0; i < lexnum; i++) {
    obj.lexicals[i] = 0;
  }

  var l = this.createPrimitive(length);
  this.setPropertyByLiteral(id, l, 'length', true, true, true);
  return id;
};

/**
 * Create a new native function.
 * 
 * @param {!Function}
 *          nativeFunc JavaScript function.
 * @return {!Object} New function.
 */
RedbankVM.prototype.createNativeFunction = function(nativeFunc, tag) {

  if (this.FUNCTION.proto === undefined || this.FUNCTION.proto === null) {
    throw "FUNCTION.prototype not initialized.";
  }

  var func = this.createObject(this.FUNCTION.proto, tag);
  func.nativeFunc = nativeFunc;
  var id = this.createPrimitive(nativeFunc.length);
  this.setPropertyByLiteral(func, id, 'length', false, false, false);
  return func;
};

RedbankVM.prototype.findProperty = function(object, name) {

  if (typeof object !== 'number' || typeof name !== 'number') {
    throw "Not an object id";
  }

  var obj = this.getObject(object);

  for (var prop = obj.property; prop !== 0; prop = this.getObject(prop).nextInObject) {
    if (this.getObject(prop).name === name) {
      return prop;
    }
  }

  return;
};

/**
 * Set a property value on a data object.
 * 
 * @param {!Object}
 *          obj Data object.
 * @param {*}
 *          name Name of property.
 * @param {*}
 *          value New property value.
 * @param {boolean}
 *          opt_fixed Unchangeable property if true.
 * @param {boolean}
 *          opt_nonenum Non-enumerable property if true.
 */
RedbankVM.prototype.setProperty = function(parent, child, name, writable,
    enumerable, configurable) {

  var obj;

  // for debug
  if (typeof parent !== 'number' || typeof child !== 'number') {
    throw "Convert object to object id for setProperty";
  }

  obj = this.Objects[parent];

  /**
   * any string is valid for js property name, including undefined, null, and
   * numbers number property name can NOT be used with dot notation, but bracket
   * notation is OK. other strings are OK for both dot and bracket notation.
   */
  // name = name.toString();
  if (obj.isPrimitive) {
    return;
  }

  // if (this.isa(obj, this.STRING)) {
  // var n = this.arrayIndex(name);
  // if (name == 'length' || (!isNaN(n) && n < obj.data.length)) {
  // // Can't set length or letters on Strings.
  // return;
  // }
  // }

  // if (this.isa(obj, this.ARRAY)) {
  // // Arrays have a magic length variable that is bound to the elements.
  // var i;
  // if (name == 'length') {
  // // Delete elements if length is smaller.
  // var newLength = this.arrayIndex(value.toNumber());
  // if (isNaN(newLength)) {
  // throw new RangeError('Invalid array length');
  // }
  // if (newLength < obj.length) {
  // for (i in obj.properties) {
  // i = this.arrayIndex(i);
  // if (!isNaN(i) && newLength <= i) {
  // delete obj.properties[i];
  // }
  // }
  // }
  // obj.length = newLength;
  // return; // Don't set a real length property.
  // }
  // else if (!isNaN(i = this.arrayIndex(name))) {
  // // Increase length if this index is larger.
  // obj.length = Math.max(obj.length, i + 1);
  // }
  // }

  // Set the property.
  // obj.properties[name] = value;
  // if (opt_fixed) {
  // obj.fixed[name] = true;
  // }
  // if (opt_nonenum) {
  // obj.nonenumerable[name] = true;
  // }

  var prop = this.findProperty(parent, name);

  if (prop === undefined) {

    var property = {

      type : 'property',

      child : 0,
      name : 0,
      nextInObject : 0,
      nextInSlot : 0,

      REF : {
        count : 0,
        referrer : [],
      },

      parent : parent,
      writable : (writable === true) ? true : false,
      enumerable : (enumerable === true) ? true : false,
      configurable : (configurable === true) ? true : false,
    };
    var id = this.register(property);

    this.install(id, 'child', child);
    this.install(id, 'name', name);
    this.install(id, 'nextInObject', this.getObject(parent).property);
    this.install(parent, 'property', id);
  }
  else if (this.getObject(prop).writable === false) {
    return;
  }
  else {
    this.install(prop, 'child', child);
  }
};

RedbankVM.prototype.setPropertyByLiteral = function(parent, child, nameLiteral,
    writable, enumerable, configurable) {

  var name = this.createPrimitive(nameLiteral);
  this.setProperty(parent, child, name, writable, enumerable, configurable);
};

RedbankVM.prototype.getProperty = function(parent, name) {

  var prop = this.findProperty(parent, name);

  if (prop === undefined) {
    return this.UNDEFINED;
  }
  var id = this.getObject(prop).child;
  return (id === 0) ? this.UNDEFINED : id;
};

RedbankVM.prototype.init = function() {

  // lexical for nested function
  var vm = this;
  var wrapper, id, obj;

  this.register({
    type : 'poison'
  });

  // put vm inside objects array
  this.type = 'machine';
  id = this.register(this);

  id = this.createPrimitive(undefined, "UNDEFINED");
  this.UNDEFINED = id;
  obj = this.getObject(id);
  obj.REF.count = Infinity; // TODO refactoring

  id = this.createPrimitive(true, "TRUE");
  this.TRUE = id;
  obj = this.getObject(id);
  obj.REF.count = Infinity;

  id = this.createPrimitive(false, "FALSE");
  this.FALSE = id;
  obj = this.getObject(id);
  obj.REF.count = Infinity;

  // Object.prototype inherits null TODO
  id = this.createObject(0, "Object.prototype");
  obj = this.getObject(id);
  obj.REF.count = Infinity;
  this.OBJECT = {};
  this.OBJECT.proto = id;
  
  id = this.createObject(this.OBJECT.proto, "Global Object");
  obj = this.getObject(id);
  obj.REF.count = Infinity;
  this.GLOBAL = id;
  
  this.setPropertyByLiteral(this.GLOBAL, this.UNDEFINED, 'undefined', false, false, false);

  // Function.prototype inherits Object.prototype
  // createNativeFunction require this prototype
  id = this.createObject(this.OBJECT.proto, "Function.prototype");
  obj = this.Objects[id];
  obj.type = 'function';
  this.FUNCTION = {};
  this.FUNCTION.proto = id;

  // Object.prototype.toString(), native
  wrapper = function() { // TODO don't know if works
    return vm.createPrimitive(this.toString());
  };
  id = this.createNativeFunction(wrapper, "Object.prototype.toString()");
  this.setPropertyByLiteral(this.OBJECT.proto, id, 'toString', true, false,
      true);

  // Object.prototype.valueOf(), native
  wrapper = function() { // TODO don't know if works
    return vm.createPrimitive(this.valueOf());
  };
  id = this.createNativeFunction(wrapper, "Object.prototype.valueOf()");
  this
      .setPropertyByLiteral(this.OBJECT.proto, id, 'valueOf', true, false, true);

  // TODO add more native functions according to ECMA standard

  // Object constructor, native
  wrapper = function(var_args) {
    var newObj;

    if (this.parent === vm.OBJECT) {
      throw "new is not supported yet";
      // Called with new.
      newObj = this;
    }
    else {
      newObj = vm.createObject(vm.OBJECT.proto);
    }
    return newObj;
  };
  id = this.createNativeFunction(wrapper, "Object constructor");
  this.setPropertyByLiteral(id, this.OBJECT.proto, 'prototype', false, false,
      false);
  this.OBJECT.ctor = id;

  // Function constructor. TODO need to adapt
  wrapper = function(var_args) {

    var newFunc, code;

    if (this.PROTOTYPE === vm.FUNCTION) {
      // Called with new.
      newFunc = this;
    }
    else {
      newFunc = vm.createObject(vm.FUNCTION);
    }
    if (arguments.length) {
      code = arguments[arguments.length - 1].toString();
    }
    else {
      code = '';
    }
    var args = [];
    for (var i = 0; i < arguments.length - 1; i++) {
      args.push(arguments[i].toString());
    }
    args = args.join(', ');
    if (args.indexOf(')') !== -1) {
      throw new SyntaxError('Function arg string contains parenthesis');
    }
    // Interestingly, the scope for constructed functions is the global scope,
    // even if they were constructed in some other scope. TODO what does this
    // mean?
    // newFunc.parentScope =
    // vm.stateStack[vm.stateStack.length - 1].scope;
    // var ast = esprima.parse('$ = function(' + args + ') {' + code + '};');
    // newFunc.node = ast.body[0].expression.right;
    // vm.setProperty(newFunc, 'length',
    // vm.createPrimitive(newFunc.node.length), true);
    return newFunc;
  };

  id = this.createNativeFunction(wrapper, "Function constructor");
  this.setPropertyByLiteral(id, this.FUNCTION.proto, 'prototype', false, false,
      false);
  this.FUNCTION.ctor = id;

  // Create stub functions for apply and call.
  // These are processed as special cases in stepCallExpression.
  /**
   * var node = { type : 'FunctionApply_', params : [], id : null, body : null,
   * start : 0, end : 0 }; this.setProperty(this.FUNCTION.properties.prototype,
   * 'apply', this .createFunction(node, {}), false, true); var node = { type :
   * 'FunctionCall_', params : [], id : null, body : null, start : 0, end : 0 };
   * this.setProperty(this.FUNCTION.properties.prototype, 'call', this
   * .createFunction(node, {}), false, true); // Function has no parent to
   * inherit from, so it needs its own mandatory // toString and valueOf
   * functions. wrapper = function() { return
   * vm.createPrimitive(this.toString()); };
   * this.setProperty(this.FUNCTION.properties.prototype, 'toString', this
   * .createNativeFunction(wrapper), false, true);
   * this.setProperty(this.FUNCTION, 'toString', this
   * .createNativeFunction(wrapper), false, true); wrapper = function() { return
   * vm.createPrimitive(this.valueOf()); };
   * this.setProperty(this.FUNCTION.properties.prototype, 'valueOf', this
   * .createNativeFunction(wrapper), false, true);
   * this.setProperty(this.FUNCTION, 'valueOf',
   * this.createNativeFunction(wrapper), false, true);
   */

};

/**
 * construct a var
 */
function JSVar(type, index) {
  this.type = type;
  this.index = index;
}

RedbankVM.prototype.indexOfRET = function() {

  /**
   * FP -> function object this object argc argx ... arg0
   */

  var index = this.FP - 3; // now point to argc
  index = index - this.ARGC();
  return index; // now point to arg0
};

/**
 * Top of stack
 * 
 * @returns
 */
RedbankVM.prototype.TOS = function() {
  return this.Stack[this.Stack.length - 1];
};

RedbankVM.prototype.indexOfTOS = function() {
  return this.Stack.length - 1;
};

/**
 * Next on stack
 * 
 * @returns
 */
RedbankVM.prototype.NOS = function() {
  return this.Stack[this.Stack.length - 2];
};

RedbankVM.prototype.indexOfNOS = function() {
  return this.Stack.length - 2;
};

/**
 * The 3rd on stack
 */
RedbankVM.prototype.ThirdOS = function() {
  return this.Stack[this.Stack.length - 3];
};

RedbankVM.prototype.indexOfThirdOS = function() {
  return this.Stack.length - 3;
};

/**
 * TODO refactoring this function. Out dated.
 */
RedbankVM.prototype.assert_no_leak = function() {

  return;
  // check objects
  for (var i = 1; i < this.Objects.length; i++) {
    if (this.Objects[i] !== undefined) {
      console.log("mem leak @ object id: " + i);
    }
  }
  // check display
  // check stack
  if (this.Stack.length > 0) {
    console.log("mem leak @ stack.");
  }
};

/**
 * Assert the given id is a valid object id
 * 
 * @param id
 */
RedbankVM.prototype.assertDefined = function(id) {

  if (typeof id !== 'number' || id < 0) {
    throw "assert fail, id is NOT zero or positive number";
  }

  if (this.getObject(id) === undefined) {
    throw "assert fail, undefined object id";
  }
};

RedbankVM.prototype.assertAddr = function(id) {

  this.assertDefined(id);
  if (this.getObject(id).type !== 'addr') {
    throw "assert fail, given id is NOT an addr";
  }
};

RedbankVM.prototype.assertNonAddr = function(id) {

  this.assertDefined(id);
  if (this.getObject(id).type === 'addr') {
    throw "assert fail, given id is an addr";
  }
};

RedbankVM.prototype.assertNumber = function(id) {

  this.assertDefined(id);
  if (this.getObject(id).type !== 'number') {
    throw "assert fail, given id is NOT a number";
  }
};

RedbankVM.prototype.assertString = function(id) {

  this.assertDefined(id);
  if (this.getObject(id).type !== 'string') {
    throw "assert fail, given id is NOT a string";
  }
};

/**
 * both object and function are valid JSObject
 * 
 * @param id
 */
RedbankVM.prototype.assertJSObject = function(id) {

  this.assertDefined(id);

  var type = this.getObject(id).type;

  if (type === 'object' || type === 'function') {
    return;
  }

  throw "assert fail, given id is NEITHER object NOR function";
};

RedbankVM.prototype.assertAddrLocal = function(id) {

  this.assertAddr(id);

  var obj = this.getObject(id);
  this.assert(obj.addrType === ADDR_LOCAL);
};

/**
 * for external auto test
 */
RedbankVM.prototype.assert = function(expr) {
  if (!(expr)) {
    throw "ASSERT FAIL";
  }
};

RedbankVM.prototype.assertStackLengthEqual = function(len) {
  this.assert(this.Stack.length === len);
};

RedbankVM.prototype.assertStackSlotUndefined = function(slot) {
  this.assert(this.Stack.length > slot);
  this.assert(this.Stack[slot] === this.UNDEFINED);
};

RedbankVM.prototype.assertStackSlotNumberValue = function(slot, val) {

  var obj = this.getObject(this.Stack[slot]);
  this.assert(obj.type === 'number');
  this.assert(obj.value === val);
};

RedbankVM.prototype.assertStackSlotBooleanValue = function(slot, val) {

  if (val === true) {
    this.assert(this.Stack[slot] === this.TRUE);
  }
  else if (val === false) {
    this.assert(this.Stack[slot] === this.FALSE);
  }
  else {
    throw "unexpected assert value";
  }
};

RedbankVM.prototype.assertStackSlotObject = function(slot) {

  this.assert(this.typeOfObject(this.Stack[slot]) === 'object');
};

RedbankVM.prototype.assertStackSlotObjectPropertyNumberValue = function(slot,
    nameLit, val) {

  var id = this.Stack[slot];
  this.assert(this.typeOfObject(id) === 'object');

  var obj = this.getObject(id);
  for (var prop = obj.property; prop !== 0; prop = this.getObject(prop).nextInObject) {
    var propObj = this.getObject(prop);
    var nameObj = this.getObject(propObj.name);
    if (nameObj.value === nameLit) {
      this.assert(this.typeOfObject(propObj.child) === 'number');
      this.assert(this.getObject(propObj.child).value === val);
      return;
    }
  }

  throw "property not found or value mismatch";
};

RedbankVM.prototype.assertStackSlotFunction = function(slot) {

  var id = this.Stack[slot];
  this.assert(this.typeOfObject(id) === 'function');
};

/**
 * Get the freevar array of current function
 * 
 * @returns
 */
RedbankVM.prototype.freevars = function() {

  if (this.FP === 0) {
    throw "main function has no freevars";
  }

  var v = this.Stack[this.FP - 1]; // jsvar for Function Object
  v = this.Objects[v.index]; // function object
  return v.lexicals;
};

/**
 * This function fetch object id stored in given indexed slot in a function.
 * 
 * The link is resolved automatically.
 * 
 * @param index
 */
RedbankVM.prototype.getFuncLexical = function(index) {

};

/**
 * convert local index to (absolute) stack index
 * 
 * @param lid
 *          local index (relative to fp)
 * @returns absolute stack index
 */
RedbankVM.prototype.lid2sid = function(lid) {
  return this.FP + lid;
};

/**
 * Get current function's argument count
 * 
 * 
 * @returns argument count
 */
RedbankVM.prototype.ARGC = function() {

  if (this.FP === 0) {
    throw "main function has no args";
  }

  var id = this.Stack[this.FP - 3];
  this.assertNumber(id);
  return this.getObject(id).value;
};

/**
 * convert parameter index to (absolute) stack index
 * 
 * @param pid
 *          parameter index (relative to parameter[0], calculated from fp)
 * @returns
 */
RedbankVM.prototype.pid2sid = function(pid) {
  return this.FP - 3 - this.ARGC() + pid;
};

RedbankVM.prototype.push = function(id) {

  this.assertDefined(id);

  var index = this.Stack.length;
  this.Stack.push(0);
  this.set(id, this.id, 'Stack', index);
};

RedbankVM.prototype.pop = function() {

  var id = this.TOS();
  this.set(0, this.id, 'Stack', this.Stack.length - 1);
  this.Stack.pop();
  return; // don't return id, may be undefined
};

RedbankVM.prototype.fetcha = function() {

  this.assertAddr(this.TOS());

  var addr = this.TOS();
  var addrObj = this.getObject(addr);
  var index = addrObj.index;
  var linkObj;

  if (addrObj.addrType === ADDR_LOCAL) {
    index = this.lid2sid(index);

    if (this.typeOfObject(this.Stack[index]) === 'link') {
      linkObj = this.getObject(this.Stack[index]);

      this.set(linkObj.target, this.id, 'Stack', this.indexOfTOS());
    }
    else {
      this.set(this.Stack[index], this.id, 'Stack', this.indexOfTOS());
    }
  }
  else if (addrObj.addrType === ADDR_PARAM) {
    index = this.pid2sid(index);

    if (this.typeOfObject(this.Stack[index]) === 'link') {
      linkObj = this.getObject(this.Stack[index]);

      this.set(linkObj.target, this.id, 'Stack', this.indexOfTOS());
    }
    else {
      this.set(this.Stack[index], this.id, 'Stack', this.indexOfTOS());
    }
  }
  else if (addrObj.addrType === ADDR_LEXICAL) {

    this.assert(this.FP !== 0);

    // get function object id
    var fid = this.Stack[this.FP - 1];

    // assert it's a function
    this.assert(this.typeOfObject(fid) === 'function');

    // get object
    var funcObj = this.getObject(fid);

    // assert index not out-of-range
    this.assert(funcObj.lexnum > index);

    // retrieve link
    var link = funcObj.lexicals[index];

    // assert link
    this.assert(this.typeOfObject(link) === 'link');

    linkObj = this.getObject(link);

    this.set(linkObj.target, this.id, 'Stack', this.indexOfTOS());
  }
  else {
    throw "Unknown address type";
  }
};

RedbankVM.prototype.fetcho = function() {

  this.assertString(this.TOS());
  this.assertJSObject(this.NOS());

  var id = this.getProperty(this.NOS(), this.TOS());
  this.set(id, this.id, 'Stack', this.indexOfNOS());
  this.pop();
};

/**
 * Store or Assign
 * 
 * In store mode:
 * 
 * FORTH: addr, N1 -- (! the sequence is different from that of FORTH)
 * 
 * In assign mode:
 * 
 * FORTH: addr, N1 -- N1
 */
RedbankVM.prototype.storeOrAssignToAddress = function(mode) {

  this.assertNonAddr(this.TOS());
  this.assertAddr(this.NOS());

  var id = this.TOS();
  var addr = this.NOS();
  var addrObj = this.getObject(addr);
  var index = addrObj.index;
  var object;

  if (addrObj.addrType === ADDR_LOCAL || addrObj.addrType === ADDR_PARAM) {

    if (addrObj.addrType === ADDR_LOCAL) {
      index = this.lid2sid(index);
    }
    else {
      index = this.pid2sid(index);
    }

    if (this.typeOfObject(this.Stack[index]) === 'link') {
      object = this.Stack[index];
      this.set(id, object, 'target');
    }
    else {
      this.set(id, this.id, 'Stack', index);
    }
  }
  else if (addrObj.addrType === ADDR_LEXICAL) {
    // get function object id
    var func = this.Stack[this.FP - 1];
    var funcObj = this.getObject(func);
    var link = funcObj.lexicals[index];

    this.set(id, link, 'target');
  }
  else {
    throw "unsupported address type";
  }

  if (mode === 'store') {
    this.pop();
    this.pop();
  }
  else if (mode === 'assign') {
    // set object in TOS to NOS
    this.set(this.TOS(), this.id, 'Stack', this.indexOfNOS());
    this.pop();
  }
  else {
    throw "unsupported mode";
  }
};

/**
 * Store or Assign to object/property
 * 
 * 
 * @param mode
 */
RedbankVM.prototype.storeOrAssignToObject = function(mode) {

  this.assertNonAddr(this.TOS());
  this.assertString(this.NOS());
  this.assertJSObject(this.ThirdOS());

  this.setProperty(this.ThirdOS(), this.TOS(), this.NOS(), true, true, true);

  if (mode === 'store') {
    this.pop();
    this.pop();
    this.pop();
  }
  else if (mode === 'assign') {
    this.set(this.TOS(), this.id, 'Stack', this.indexOfThirdOS());
    this.pop();
    this.pop();
  }
};

RedbankVM.prototype.printstack = function() {

  if (this.Stack.length === 0) {
    console.log("STACK Empty");
  }
  else {
    console.log("STACK size: " + this.Stack.length);
    for (var i = this.Stack.length - 1; i >= 0; i--) {

      var id = this.Stack[i];
      var obj = this.getObject(id);

      switch (this.typeOfObject(id)) {
      case 'boolean':
        console.log(i + " : " + id + " (boolean) " + obj.value + " ref: "
            + obj.REF.count);
        break;
      case 'undefined':
        console.log(i + " : " + id + " (undefined) ref: " + obj.REF.count);
        break;
      case 'number':
        console.log(i + " : " + id + " (number) " + obj.value + " ref: "
            + obj.REF.count);
        break;
      case 'string':
        console.log(i + " : " + id + " (string) " + obj.value + " ref: "
            + obj.REF.count);
        break;
      case 'link':
        console.log(i + " : " + id + " (link) ref: " + obj.REF.count
            + "target: " + obj.target);
        break;
      case 'addr':
        console.log(i + " : " + id + " (addr) " + obj.addrType + " "
            + obj.index);
        break;
      case 'object':
        console.log(i + " : " + id + " (object) ref: " + obj.REF.count);
        break;
      case 'function':
        console.log(i + " : " + id + " (function) ");
        break;
      default:
        throw "unknown type";
      }
    }
  }
};

RedbankVM.prototype.printfreevar = function() {

  if (this.FP < 2) {
    return;
  }

  var fid = this.Stack[this.FP - 1];
  this.assert(this.typeOfObject(fid) === 'function');

  var funcObj = this.getObject(fid);
  if (funcObj.lexnum === 0 || funcObj.lexicals.length === 0) {
    return;
  }

  console.log("  --- lexicals ---");

  for (var i = 0; i < funcObj.lexicals.length; i++) {

    var link = funcObj.lexicals[i];
    var linkObj = this.getObject(link);
    if (linkObj.type !== 'link') {
      throw "non-link object in function's lexicals";
    }

    var targetObj = this.getObject(linkObj.target);
    console.log(i + " : " + "link : " + link + ", ref: " + linkObj.REF.count
        + ", target: " + linkObj.target + ", ref: " + targetObj.REF.count);
  }
};

RedbankVM.prototype.findLabel = function(code, label) {

  for (var i = 0; i < code.length; i++) {
    var bytecode = this.code[i];
    if (bytecode.op === "LABEL" && bytecode.arg1 === label) {
      return i;
    }
  }

  throw "Label not found";
};

RedbankVM.prototype.stepCapture = function(bytecode) {

  var index, id, link;

  this.assert(this.typeOfObject(this.TOS()) === 'function');

  /**
   * arg1 is the capture source, local, param, or lexical arg2 is the slot from
   * source arg3 is the slot to target
   */
  if (bytecode.arg1 === "argument" || bytecode.arg1 === "local") {
    if (bytecode.arg1 === "argument") {
      index = this.pid2sid(bytecode.arg2);
    }
    else {
      index = this.lid2sid(bytecode.arg2);
    }

    id = this.Stack[index];
    if (this.typeOfObject(id) === 'link') {
      this.set(id, this.TOS(), 'lexicals', bytecode.arg3);
    }
    else {
      // create a link, this will incr ref to target
      link = this.createLink(id);
      // TOS() is the function object
      this.set(link, this.TOS(), 'lexicals', bytecode.arg3);
      this.set(link, this.id, 'Stack', index);
    }
  }
  else if (bytecode.arg1 === "lexical") {

    var funcFrom = this.Stack[this.FP - 1];
    var funcFromObj = this.getObject(funcFrom);
    link = funcFromObj.lexicals[bytecode.arg2];
    this.set(link, this.TOS(), 'lexicals', bytecode.arg3);
  }
  else {
    throw "unknown capture from region";
  }
};

RedbankVM.prototype.step = function(code, bytecode) {
  var v, obj;
  var id, index;
  var val;
  var opd1, opd2;

  switch (bytecode.op) {

  case "CALL":
    this.PCStack.push(this.PC);
    this.FPStack.push(this.FP);
    this.PC = this.getObject(this.TOS()).label;
    this.FP = this.Stack.length;
    break;

  case "CAPTURE":
    this.stepCapture(bytecode);
    break;

  case "DROP": // n1 --
    this.pop();
    break;

  case "FETCHA": // addr -- n1
    this.fetcha();
    break;

  case "FETCHO": // O1, prop1 -- O2
    this.fetcho();
    break;

  case "FUNC": // -- f1
    id = this.createFunction(bytecode.arg1, bytecode.arg2, bytecode.arg3);
    this.push(id);
    break;

  case "JUMP":
    v = bytecode.arg1;
    v = this.findLabel(this.code, v);
    this.PC = v;
    break;

  case "JUMPC":
    if (this.TOS() === this.TRUE) {
      this.PC = this.findLabel(this.code, bytecode.arg1);
    }
    else if (this.TOS() === this.FALSE) {
      this.PC = this.findLabel(this.code, bytecode.arg2);
    }
    else {
      throw "non-boolean value on stack";
    }
    this.pop();
    break;

  case "LABEL":
    // do nothing
    break;

  case "LITA":
    // push an address, may be local, param, or closed
    if (bytecode.arg1 === "LOCAL") {
      this.push(this.createAddr(ADDR_LOCAL, bytecode.arg2));
    }
    else if (bytecode.arg1 === 'PARAM') {
      this.push(this.createAddr(ADDR_PARAM, bytecode.arg2));
    }
    else if (bytecode.arg1 === 'LEXICAL') {
      this.push(this.createAddr(ADDR_LEXICAL, bytecode.arg2));
    }
    else if (bytecode.arg1 === "PROP") {
      this.push(this.createPrimitive(bytecode.arg2));
    }
    else if (bytecode.arg1 === "GLOBAL") {
      this.push(this.GLOBAL);
      this.push(this.createPrimitive(bytecode.arg2)); // string name
    }
    else {
      throw "not supported yet";
    }

    break;

  case "LITC":
    // push an constant value
    val = bytecode.arg1;
    id = this.createPrimitive(val);
    // v = new JSVar(VT_OBJ, id);
    this.push(id);
    break;

  case "LITN":
    // push n UNDEFINED object
    for (var i = 0; i < bytecode.arg1; i++) {
      this.push(this.UNDEFINED);
    }
    break;

  case "LITO":
    // create an empty object and push to stack
    id = this.createObject(this.OBJECT.proto);
    this.push(id);
    break;

  case "RET":
    if (this.FP === 0) { // main()
      while (this.Stack.length) {
        this.pop();
      }
      this.PC = this.code.length; // exit

    }
    else {

      var result;
      var argc = this.ARGC();

      if (bytecode.arg1 === "RESULT") {
        result = this.TOS();
      }
      else {
        result = this.UNDEFINED;
      }

      // overwrite
      this.set(result, this.id, "Stack", this.indexOfRET());

      while (this.Stack.length > this.FP) {
        this.pop();
      }

      this.pop(); // pop function object
      this.pop(); // pop this object

      // don't pop argc, ret will be popped.
      // this.pop(); // argc
      for (i = 0; i < argc; i++) {
        this.pop(); // pop params
      }

      // restore fp and pc
      this.PC = this.PCStack.pop();
      this.FP = this.FPStack.pop();

      // if (result === undefined) { // no return value provided
      // this.push(this.UNDEFINED);
      // }
      // else {
      // this.Stack.push(result); // TODO
      // }
    }
    break;

  case "STORE": // addr n1 --

    if (this.typeOfObject(this.NOS()) === 'addr') {
      this.storeOrAssignToAddress('store');
    }
    else if (this.typeOfObject(this.NOS()) === 'string') {
      this.storeOrAssignToObject('store');
    }
    else {
      throw "don't known how to store";
    }
    // this.storeOrAssign('store');
    break;

  case "TEST":
    if (this.testcase !== undefined) {
      if (!(bytecode.arg1 in this.testcase)) {
        console.log(Format.dotline
            + "WARNING :: testcase does not have function " + bytecode.arg1);
      }
      else if (typeof this.testcase[bytecode.arg1] !== 'function') {
        console.log(Format.dotline + "WARNING :: testcase's property "
            + this.testcase[bytecode.arg1] + " is not a function");
      }
      else {
        console.log(Format.dotline + "[" + this.testcase.group + "] "
            + this.testcase.name);
        this.testcase[bytecode.arg1](this);
        console.log(Format.dotline + "[PASS]");
      }
    }
    else {
      console.log(Format.dotline + "WARNING :: testcase not found");
    }
    break;

  case "+":
    // assert, only number supported up to now
    this.assertNumber(this.TOS());
    this.assertNumber(this.NOS());

    v = this.getObject(this.TOS()).value + this.getObject(this.NOS()).value;

    // pop operand
    this.pop();
    this.pop();

    // create new value object
    id = this.createPrimitive(v);

    // push result on stack
    this.push(id);
    break;

  case "*":
    // assert, only number supported up to now
    this.assertNumber(this.TOS());
    this.assertNumber(this.NOS());

    v = this.getObject(this.TOS()).value * this.getObject(this.NOS()).value;

    // pop operand
    this.pop();
    this.pop();

    id = this.createPrimitive(v);

    // push result on stack
    this.push(id);
    break;

  case '=':
    if (this.typeOfObject(this.NOS()) === 'addr') {
      this.storeOrAssignToAddress('assign');
    }
    else if (this.typeOfObject(this.NOS()) === 'string') {
      this.storeOrAssignToObject('assign');
    }
    else {
      throw "don't known how to assign";
    }
    // this.storeOrAssign('assign');
    break;

  case '===':
    this.assertNonAddr(this.TOS());
    this.assertNonAddr(this.NOS());

    var equality;

    if (this.typeOfObject(this.TOS()) !== this.typeOfObject(this.NOS())) {
      equality = false;
    }
    else {
      var type = this.typeOfObject(this.TOS());
      if (type === 'undefined') {
        equality = true;
      }
      else if (type === 'boolean') {
        equality = (this.TOS() === this.NOS());
      }
      else if (type === 'number') {
        equality = (this.getObject(this.TOS()).value === this.getObject(this
            .NOS()).value);
      }
      else if (type === 'string') { // TODO now all strings are interned
        equality = (this.TOS() === this.NOS());
      }
      else if (type === 'object' || type === "function") {
        equality = (this.TOS() === this.NOS());
      }
      else {
        throw "not supported for equality";
      }
    }

    this.pop();
    this.pop();

    if (equality) {
      this.push(this.TRUE);
    }
    else {
      this.push(this.FALSE);
    }

    break;

  default:
    throw "!!! unknown instruction : " + bytecode.op;
  }
};

RedbankVM.prototype.run = function(input, testcase) {

  this.init();

  this.code = input;
  this.testcase = testcase;

  console.log(Format.hline);
  console.log("[[Start Running ]]");
  console.log(Format.hline);

  while (this.PC < this.code.length) {

    var bytecode = this.code[this.PC];

    this.printstack();
    this.printfreevar();
    console.log(Format.hline);
    console.log("PC : " + this.PC + ", FP : " + this.FP);
    console.log("OPCODE: " + bytecode.op + ' '
        + ((bytecode.arg1 === undefined) ? '' : bytecode.arg1) + ' '
        + ((bytecode.arg2 === undefined) ? '' : bytecode.arg2) + ' '
        + ((bytecode.arg3 === undefined) ? '' : bytecode.arg3));

    // like the real
    this.PC++;
    this.step(this.code, bytecode);
  }

  this.printstack();
  this.printfreevar();
  this.assert_no_leak();
};

module.exports = RedbankVM;
