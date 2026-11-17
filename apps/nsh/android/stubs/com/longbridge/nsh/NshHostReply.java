package com.longbridge.nsh;

public final class NshHostReply {
  NshHostReply(long call) {}

  public synchronized boolean isPost() {
    throw new RuntimeException("Stub");
  }

  public void resolve(Object value) {
    throw new RuntimeException("Stub");
  }

  public void reject(String error) {
    throw new RuntimeException("Stub");
  }
}
