# The Gmail REST client reflects over its generated model classes, so R8 must
# not rename or strip them. Without this, release builds fail at runtime with
# a bare NoSuchFieldException rather than at compile time.
-keep class com.google.api.client.** { *; }
-keep class com.google.api.services.gmail.** { *; }
-keepclassmembers class * { @com.google.api.client.util.Key <fields>; }
-dontwarn com.google.api.client.**
-dontwarn org.apache.http.**
-dontwarn android.net.compatibility.**

# Room generated implementations.
-keep class * extends androidx.room.RoomDatabase { <init>(); }

# kotlinx.serialization keeps its generated serializers via @Serializable.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class com.parentsync.mobile.** {
    *** Companion;
}
