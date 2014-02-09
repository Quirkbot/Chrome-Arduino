// Board API (in progress):
//
// Connect
// ReadFlash
// WriteFlash

// API
function NewAvr109Board(serial, pageSize) {
  if (typeof(serial) === "undefined") {
    return { status: Status.Error("serial is undefined") }
  }

  if (typeof(pageSize) === "undefined") {
    return { status: Status.Error("pageSize is undefined") }
  }

  return { status: Status.OK,
           board: new Avr109Board(serial, pageSize) };
};

function Avr109Board(serial, pageSize) {
  this.serial_ = serial;
  this.pageSize_ = pageSize;
};

Avr109Board.prototype.connect = function(deviceName, doneCb) {
  // TODO: Validate doneCb
  // TODO: Validate deviceName?
  if (this.state_ != Avr109Board.State.DISCONNECTED) {
    doneCb(Status.Error("Can't connect. Current state: " + this.state_));
    return;
  }

  this.state_ = Avr109Board.State.CONNECTING;
  this.kickBootloader_(deviceName, doneCb);
};

Avr109Board.prototype.writeFlash = function(boardAddress, data, doneCb) {
  if (this.state_ != Avr109Board.State.CONNECTED) {
    return doneCb(Status.Error("Not connected to board: " + this.state_));
  };

  if (boardAddress % this.pageSize_ != 0) {
    return doneCb(Status.Error(
      "boardAddress must be alligned to page size of " + this.pageSize_
        + " (" + boardAddress + " % " + this.pageSize_ + " == "
        + (boardAddress % this.pageSize_) + ")"));
  }

  if (data.length % this.pageSize_ != 0) {
    return doneCb(Status.Error(
      "data size must be alligned to page size of " + this.pageSize_
        + " (" + data.length + " % " + this.pageSize_ + " == "
        + (data.length % this.pageSize_) + ")"));
  }


  var board = this;
  this.writeAndGetReply_(
    [AVR.ENTER_PROGRAM_MODE],
    function(response) {
      var hexResponse = binToHex(response.data);
      if (hexResponse.length == 1 && hexResponse[0] == 0x0D) {
        board.beginProgramming_(boardAddress, data, doneCb)
      } else {
        return doneCb(Status.Error(
          "Error entering program mode: " + hexRep(response)));
      }
    });
};

Avr109Board.prototype.readFlash = function(boardAddress, length, doneCb) {
  if (this.state_ != Avr109Board.State.CONNECTED) {
    doneCb({
      status: Status.Error("Not connected to board: " + this.state_) });
  } else {
    doneCb({
      status: Status.Error("Not implemented")});
  }
};

// IMPLEMENTATION
Avr109Board.State = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected"
};

Avr109Board.prototype.pageSize_ = -1;
Avr109Board.prototype.serial_ = null;
Avr109Board.prototype.state_ = Avr109Board.State.DISCONNECTED;
Avr109Board.prototype.connectionId_ = -1;
Avr109Board.prototype.clock_ = new RealClock;
Avr109Board.prototype.readHandler_ = null;

Avr109Board.MAGIC_BITRATE = 1200;

Avr109Board.prototype.readDispatcher_ = function(readArg) {
  if (this.readHandler_ != null) {
    this.readHandler_(readArg);
    return;
  }

  log(kDebugNormal, "No read handler for: " + JSON.stringify(readArg));
}

Avr109Board.prototype.kickBootloader_ = function(originalDeviceName, doneCb) {
  var oldDevices = [];
  var serial = this.serial_;
  var board = this;

  serial.getDevices(function(devicesArg) {
    oldDevices = devicesArg;
    serial.connect(originalDeviceName, {bitrate: Avr109Board.MAGIC_BITRATE }, function(connectArg) {
      // TODO: validate connect arg
      serial.disconnect(connectArg.connectionId, function(disconnectArg) {
        // TODO: validate disconnect arg
        board.waitForNewDevice_(
          oldDevices, doneCb, board.clock_.nowMillis() + 10 * 1000);
      });
    });
  });
}

function findMissingIn(needles, haystack) {
  var haystack2 = [];
  for (var i = 0; i < haystack.length; ++i) {
    haystack2.push(haystack[i].path);
  }

  var r = [];
  for (var i = 0; i < needles.length; ++i) {
    if (haystack2.indexOf(needles[i].path) == -1) {
      r.push(needles[i].path);
    }
  }

  return r;
}

Avr109Board.prototype.waitForNewDevice_ = function(oldDevices, doneCb, deadline) {
  var serial = this.serial_;
  var board = this;

  if (this.clock_.nowMillis() > deadline) {
    doneCb(Status.Error("Deadline exceeded while waiting for new devices"));
    return;
  }

  var found = false;
  serial.getDevices(function(newDevices) {
    var appeared = findMissingIn(newDevices, oldDevices);
    var disappeared = findMissingIn(oldDevices, newDevices);
 
    for (var i = 0; i < disappeared.length; ++i) {
      log(kDebugNormal, "Disappeared: " + disappeared[i]);
    }
    for (var i = 0; i < appeared.length; ++i) {
      log(kDebugNormal, "Appeared: " + appeared[i]);
    }

    if (appeared.length == 0) {
      setTimeout(function() {
        board.waitForNewDevice_(newDevices, doneCb, deadline);
      }, 10);
    } else {
      log(kDebugNormal, "Aha! Connecting to: " + appeared[0]);
      // Note: I removed what I think was an unnecessary setTimeout(500)
      // here.  If things look buggy, we can add it back
      serial.connect(
        appeared[appeared.length - 1],
        { bitrate: 57600 },
        function(connectArg) { board.serialConnected_(connectArg, doneCb) });
    }
  });
}

Avr109Board.prototype.serialConnected_ = function(connectArg, doneCb) {
  // TODO: test this?
  if (typeof(connectArg) == "undefined" ||
      typeof(connectArg.connectionId) == "undefined" ||
      connectArg.connectionId == -1) {
    doneCb(Status.Error("Couldn't connect to board"));
    return;
  }

  this.connectionId_ = connectArg.connectionId;
  this.serial_.onReceive.addListener(this.readDispatcher_.bind(this));
  this.startCheckSoftwareVersion_(doneCb);
}

Avr109Board.prototype.writeAndGetReply_ = function(payload, handler) {
  
  this.setReadHandler_(handler);
  this.write_(payload);
};

Avr109Board.prototype.write_ = function(payload) {
  this.serial_.send(
    this.connectionId_, hexToBin(payload), function(writeArg) {
      // TODO: veridy writeArg
    });
}


Avr109Board.prototype.setReadHandler_ = function(handler) {
  this.readHandler_ = handler;
};

Avr109Board.prototype.startCheckSoftwareVersion_ = function(doneCb) {
  var board = this;
  this.writeAndGetReply_(
    [ AVR.SOFTWARE_VERSION ],
    function(readArg) {
      board.finishCheckSoftwareVersion_(readArg, doneCb);
    });
}

Avr109Board.prototype.finishCheckSoftwareVersion_ = function(readArg, doneCb) {
  var hexData = binToHex(readArg.data);
  // TODO: actuall examine response
  if (hexData.length == 2) {
    this.state_ = Avr109Board.State.CONNECTED;
    doneCb(Status.OK);
  }

  // TODO: Deadline?
};


Avr109Board.prototype.beginProgramming_ = function(boardAddress, data, doneCb) {
  var board = this;
  var addressBytes = storeAsTwoBytes(boardAddress);
  this.writeAndGetReply_(
    // TODO: endianness
    [AVR.SET_ADDRESS, addressBytes[1], addressBytes[0]],
    function(readArg) {
      var hexData = binToHex(readArg.data);
      if (hexData.length == 1 && hexData[0] == 0x0D) {
        board.writePage_(0, data, doneCb);
      } else {
        return doneCb(Status.Error("Error setting address."));
      }
    });
}

Avr109Board.prototype.writePage_ = function(pageNo, data, doneCb) {
  var numPages = data.length / this.pageSize_;
  if (pageNo == 0 || pageNo == numPages - 1 || (pageNo + 1) % 5 == 0) {
    log(kDebugFine, "Writing page " + (pageNo + 1) + " of " + numPages);
  }

  var board = this;
  var pageSize = this.pageSize_;

  var payload = data.slice(pageNo * this.pageSize_,
                           (pageNo + 1) * this.pageSize_);

  var sizeBytes = storeAsTwoBytes(this.pageSize_);

  // TODO: endianness
  var writeMessage = [AVR.WRITE, sizeBytes[0], sizeBytes[1], AVR.TYPE_FLASH];
  writeMessage = writeMessage.concat(payload);

  this.writeAndGetReply_(
    writeMessage,
    function(readArg) {
      var hexData = binToHex(readArg.data);
      if (hexData.length == 1 && hexData[0] == 0x0D) {
        if (pageSize * (pageNo + 1) >= data.length) {
          return board.doneProgramming_(doneCb);
        }
        board.writePage_(pageNo + 1, data, doneCb);
      } else {
        return doneCb(Status.Error("Error writing page " + pageNo + ": " +
                                   hexRep(hexData)));
      }
    });
}

Avr109Board.prototype.doneProgramming_ = function(doneCb) {
  var board = this;
  this.writeAndGetReply_(
    [AVR.LEAVE_PROGRAM_MODE],
    function(readArg) {
      var hexData = binToHex(readArg.data);
      if (hexData.length == 1 && hexData[0] == AVR.CR) {
        board.exitBootloader_(doneCb);
      } else {
        doneCb(Status.Error("Error leaving progam mode: " + hexRep(hexData)));
      }
    });
};

Avr109Board.prototype.exitBootloader_ = function(doneCb) {
  this.writeAndGetReply_(
    [AVR.EXIT_BOOTLOADER],
    function(readArg) {
      var hexData = binToHex(readArg.data);
      if (hexData.length == 1 && hexData[0] == AVR.CR) {
        doneCb(Status.OK);
      } else {
        doneCb(Status.Error("Error leaving bootloader: " + hexRep(hexData)));
      }
    });
}
