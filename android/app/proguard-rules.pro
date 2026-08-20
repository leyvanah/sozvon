# The app's own code is a thin WebView shell and uses no reflection.  Its SSH
# library does, and that is not visible to the shrinker.
#
# JSch picks its ciphers, MACs, key exchanges, signatures, compression and its
# random source by *class name*, from the configuration table in JSch.java, and
# instantiates them with Class.forName.  Nothing in the bytecode refers to
# those classes, so R8 removed 411 of them -- including every
# com.jcraft.jsch.jce.* implementation.  The app then died at the first SSH
# connection with
#
#     java.lang.ClassNotFoundException: com.jcraft.jsch.jce.Random
#
# Channels are resolved the same way (Channel.getChannel resolves "exec",
# "sftp" and friends by name), so keeping only the jce package would move the
# failure rather than fix it.  Keep the library whole: it is a few hundred
# kilobytes next to a payload of some seventeen megabytes.
-keep class com.jcraft.jsch.** { *; }
-dontwarn com.jcraft.jsch.**

# WebView JS interfaces would need keep rules too, if any are ever added.
